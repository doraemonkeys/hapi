import { ApiClient } from '@/api/api';
import { RunnerState } from '@/api/types';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeRunnerState, RunnerLocallyPersistedState, readRunnerState, acquireRunnerLock, releaseRunnerLock } from '@/persistence';
import { isWindows, getProcessMemory } from '@/utils/process';
import { withRetry } from '@/utils/time';
import { isRetryableConnectionError } from '@/utils/errorUtils';

import { cleanupRunnerState, getInstalledCliMtimeMs, isRunnerRunningCurrentlyInstalledHappyVersion, stopRunner } from './controlClient';
import { startRunnerControlServer } from './controlServer';
import { buildMachineMetadata } from '@/agent/sessionFactory';
import { createRunnerSessionManager } from './sessionManager';
import { getReconnectStats } from '@/api/socketReconnectPolicy';
import type { RunnerDiagnostics } from './diagnostics';

/** Compact bytes → human-readable string (e.g. 42.5 MB). */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function startRunner(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[RUNNER RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[RUNNER RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[RUNNER RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[RUNNER RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  if (isWindows()) {
    process.on('SIGBREAK', () => {
      logger.debug('[RUNNER RUN] Received SIGBREAK');
      requestShutdown('os-signal');
    });
  }

  process.on('uncaughtException', (error) => {
    logger.debug('[RUNNER RUN] FATAL: Uncaught exception', error);
    logger.debug(`[RUNNER RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[RUNNER RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[RUNNER RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[RUNNER RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[RUNNER RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[RUNNER RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[RUNNER RUN] Starting runner process...');
  logger.debugLargeJson('[RUNNER RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running runner version matches current CLI version
  const runningRunnerVersionMatches = await isRunnerRunningCurrentlyInstalledHappyVersion();
  if (!runningRunnerVersionMatches) {
    logger.debug('[RUNNER RUN] Runner version mismatch detected, restarting runner with current CLI version');
    await stopRunner();
  } else {
    logger.debug('[RUNNER RUN] Runner version matches, keeping existing runner');
    console.log('Runner already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves runner is running)
  const runnerLockHandle = await acquireRunnerLock(5, 200);
  if (!runnerLockHandle) {
    logger.debug('[RUNNER RUN] Runner lock file already held, another runner is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the runner:
  // 1. Not have a stale runner state
  // 2. Should not have another runner process running

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[RUNNER RUN] Auth and machine setup complete');

    const sessionManager = createRunnerSessionManager();

    // Start orphan sweep: immediate prune on startup + periodic heartbeat
    const stopOrphanSweep = sessionManager.startOrphanSweepLoop();

    // Start control server
    const collectDiagnostics = (): RunnerDiagnostics => {
      const mem = process.memoryUsage();
      const children = sessionManager.getCurrentChildren();
      const pids = children.map(c => c.pid);
      const memMap = pids.length > 0 ? getProcessMemory(pids) : new Map<number, number | null>();
      const maxActiveSessions = parseInt(process.env.HAPI_RUNNER_MAX_ACTIVE_SESSIONS ?? '10', 10);

      return {
        runner: {
          pid: process.pid,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          externalBytes: mem.external,
          uptimeSeconds: Math.round(process.uptime()),
        },
        sessions: children.map(c => ({
          pid: c.pid,
          sessionId: c.happySessionId ?? null,
          rssBytes: memMap.get(c.pid) ?? null,
        })),
        sessionCap: {
          active: children.length,
          max: maxActiveSessions,
        },
        reconnect: getReconnectStats(),
      };
    };

    const { port: controlPort, stop: stopControlServer } = await startRunnerControlServer({
      getChildren: sessionManager.getCurrentChildren,
      stopSession: sessionManager.stopSession,
      spawnSession: sessionManager.spawnSession,
      requestShutdown: () => requestShutdown('hapi-cli'),
      onHappySessionWebhook: sessionManager.onHappySessionWebhook,
      getDiagnostics: collectDiagnostics
    });

    const startedWithCliMtimeMs = getInstalledCliMtimeMs();

    // Write initial runner state (no lock needed for state file)
    const fileState: RunnerLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
      runnerLogPath: logger.logFilePath
    };
    writeRunnerState(fileState);
    logger.debug('[RUNNER RUN] Runner state written');

    // Prepare initial runner state
    const initialRunnerState: RunnerState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create();

    // Get or create machine (with retry for transient connection errors)
    const machine = await withRetry(
      () => api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata(),
        runnerState: initialRunnerState
      }),
      {
        maxAttempts: 60,
        minDelay: 1000,
        maxDelay: 30000,
        shouldRetry: isRetryableConnectionError,
        onRetry: (error, attempt, nextDelayMs) => {
          const errorMsg = error instanceof Error ? error.message : String(error)
          logger.debug(`[RUNNER RUN] Failed to register machine (attempt ${attempt}), retrying in ${nextDelayMs}ms: ${errorMsg}`)
        }
      }
    );
    logger.debug(`[RUNNER RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession: sessionManager.spawnSession,
      stopSession: sessionManager.stopSession,
      requestShutdown: () => requestShutdown('hapi-app'),
      forkSession: sessionManager.forkSession
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if runner needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[RUNNER RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      sessionManager.pruneStaleSessions();

      // Check if runner needs update
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[RUNNER RUN] Runner is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new runner through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if runner is running (yes in this case)
        // 2. If the version is stale (it will read runner.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new runner with the latest version with runner-sync :D
        // Done!
        try {
          spawnHappyCLI(['runner', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[RUNNER RUN] Failed to spawn new runner, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[RUNNER RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
      }

      // Before wrecklessly overriting the runner state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const runnerState = await readRunnerState();
      if (runnerState && runnerState.pid !== process.pid) {
        logger.debug('[RUNNER RUN] Somehow a different runner was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different runner was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: RunnerLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          startedWithCliMtimeMs,
          lastHeartbeat: new Date().toLocaleString(),
          runnerLogPath: fileState.runnerLogPath
        };
        writeRunnerState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[RUNNER RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Declare here so cleanup closure can reference it; assigned after cleanup definition
    let memorySampleInterval: ReturnType<typeof setInterval> | null = null;

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[RUNNER RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[RUNNER RUN] Health check interval cleared');
      }

      // Clear memory sampling interval
      if (memorySampleInterval) {
        clearInterval(memorySampleInterval);
      }

      // Dispose session manager timers (idle trackers + orphan sweep)
      stopOrphanSweep();
      sessionManager.dispose();

      // Update runner state before shutting down
      await apiMachine.updateRunnerState((state: RunnerState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupRunnerState();
      await releaseRunnerLock(runnerLockHandle);

      logger.debug('[RUNNER RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    // --- Runner self-sampling: log own memory footprint periodically ---
    // Also samples child session memory using OS-level PID queries, batched
    // on Windows to amortize PowerShell cold-start cost.
    const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000; // 5 minutes
    memorySampleInterval = setInterval(() => {
      // Runner process memory
      const mem = process.memoryUsage();
      logger.debug(
        `[RUNNER MEM] rss=${formatBytes(mem.rss)} heapUsed=${formatBytes(mem.heapUsed)} heapTotal=${formatBytes(mem.heapTotal)} external=${formatBytes(mem.external)}`
      );

      // Child session memory (batch all PIDs into a single OS call)
      const children = sessionManager.getCurrentChildren();
      if (children.length > 0) {
        const pids = children.map(c => c.pid);
        const memMap = getProcessMemory(pids);
        const entries: string[] = [];
        for (const child of children) {
          const rss = memMap.get(child.pid);
          const label = child.happySessionId?.slice(0, 8) ?? `PID-${child.pid}`;
          entries.push(`${label}=${rss !== null && rss !== undefined ? formatBytes(rss) : 'n/a'}`);
        }
        logger.debug(`[RUNNER MEM] sessions(${children.length}): ${entries.join(', ')}`);
      }
    }, MEMORY_SAMPLE_INTERVAL_MS);
    if (memorySampleInterval.unref) {
      memorySampleInterval.unref();
    }

    logger.debug('[RUNNER RUN] Runner started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[RUNNER RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
