import fs from 'fs/promises';
import os from 'os';
import { join } from 'path';

import type { Metadata } from '@/api/types';
import type { ForkSessionOptions, ForkSessionResult, SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import { forkClaudeSession } from '@/claude/utils/forkSession';
import { forkCodexSession } from '@/codex/utils/forkSession';
import { logger } from '@/ui/logger';
import { isProcessAlive, killProcess, killProcessByChildProcess } from '@/utils/process';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { augmentPathWithToolManagers } from '@/utils/toolPaths';
import type { TrackedSession } from './types';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktree';
import { IdleTracker } from './idleTracker';

type SessionAwaiter = (session: TrackedSession) => void;

export type RunnerSessionManager = {
    getCurrentChildren: () => TrackedSession[];
    onHappySessionWebhook: (sessionId: string, sessionMetadata: Metadata) => void;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    forkSession: (options: ForkSessionOptions) => Promise<ForkSessionResult>;
    stopSession: (sessionId: string) => boolean;
    pruneStaleSessions: () => void;
    /** Touch idle tracker for a session (terminal I/O, RPC, socket message). */
    touchSession: (sessionId: string) => void;
    /** Start orphan sweep loop; returns cleanup function. */
    startOrphanSweepLoop: () => () => void;
    /** Tear down all idle trackers and sweep interval. */
    dispose: () => void;
};

// --- Config from environment ---

const MAX_ACTIVE_SESSIONS = parseInt(
    process.env.HAPI_RUNNER_MAX_ACTIVE_SESSIONS ?? '10', 10
);
const IDLE_SESSION_TTL_MS = parseInt(
    process.env.HAPI_RUNNER_IDLE_SESSION_TTL_MS ?? '3600000', 10
);
const ORPHAN_SWEEP_INTERVAL_MS = parseInt(
    process.env.HAPI_RUNNER_ORPHAN_SWEEP_INTERVAL_MS ?? '300000', 10
);

// --- Internal constants ---

const WEBHOOK_TIMEOUT_MS = 15_000;
const MAX_STDERR_TAIL_CHARS = 4_000;
const WORKTREE_REQUIRED_MESSAGE = 'Worktree sessions require an existing Git repository.';

function appendTail(current: string, chunk: Buffer | string): string {
    const text = chunk.toString();
    if (!text) {
        return current;
    }
    const combined = current + text;
    return combined.length > MAX_STDERR_TAIL_CHARS ? combined.slice(-MAX_STDERR_TAIL_CHARS) : combined;
}

export function createRunnerSessionManager(): RunnerSessionManager {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, SessionAwaiter>();
    const pidToIdleTracker = new Map<number, IdleTracker>();
    let orphanSweepInterval: ReturnType<typeof setInterval> | null = null;

    // --- Helpers ---

    /** Count only runner-spawned sessions whose process is still alive. */
    const countActiveRunnerSessions = (): number => {
        let count = 0;
        for (const session of pidToTrackedSession.values()) {
            if (session.startedBy === 'runner' && isProcessAlive(session.pid)) {
                count++;
            }
        }
        return count;
    };

    /**
     * Pre-rejection hygiene: remove dead PIDs from the tracking map so
     * stale/crashed session ghosts don't consume cap slots.
     */
    const pruneDeadEntries = (): void => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (!isProcessAlive(pid)) {
                logger.debug(`[RUNNER RUN] Pruning dead entry PID ${pid} (session ${session.happySessionId ?? 'unknown'})`);
                pidToTrackedSession.delete(pid);
                disposeIdleTracker(pid);
            }
        }
    };

    const disposeIdleTracker = (pid: number): void => {
        const tracker = pidToIdleTracker.get(pid);
        if (tracker) {
            tracker.dispose();
            pidToIdleTracker.delete(pid);
        }
    };

    /** Idle expiry handler: kill the runner-spawned session. */
    const onIdleExpired = (pid: number, sessionId: string | undefined): void => {
        logger.debug(
            `[RUNNER RUN] Idle TTL expired for PID ${pid} (session ${sessionId ?? 'unknown'}); killing`
        );

        const session = pidToTrackedSession.get(pid);
        if (!session) {
            return;
        }

        // Only auto-kill runner-managed sessions
        if (session.startedBy !== 'runner') {
            logger.debug(`[RUNNER RUN] PID ${pid} not runner-spawned (startedBy=${session.startedBy}); skipping idle kill`);
            return;
        }

        if (session.childProcess) {
            void killProcessByChildProcess(session.childProcess);
        } else {
            void killProcess(pid);
        }

        // Tracking entry will be removed by the exit handler (onChildExited)
    };

    const createIdleTrackerForSession = (pid: number, sessionId: string | undefined): IdleTracker => {
        const tracker = new IdleTracker(pid, sessionId, IDLE_SESSION_TTL_MS, onIdleExpired);
        pidToIdleTracker.set(pid, tracker);
        return tracker;
    };

    // --- Public API ---

    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    const touchSession = (sessionId: string): void => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.happySessionId === sessionId) {
                pidToIdleTracker.get(pid)?.touch();
                return;
            }
        }
    };

    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata): void => {
        logger.debugLargeJson('[RUNNER RUN] Session reported', sessionMetadata);

        const pid = sessionMetadata.hostPid;
        if (!pid) {
            logger.debug(`[RUNNER RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
            return;
        }

        logger.debug(`[RUNNER RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
        logger.debug(`[RUNNER RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

        const existingSession = pidToTrackedSession.get(pid);
        if (existingSession && existingSession.startedBy === 'runner') {
            existingSession.happySessionId = sessionId;
            existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
            logger.debug(`[RUNNER RUN] Updated runner-spawned session ${sessionId} with metadata`);

            // Update the idle tracker with the now-known session ID
            pidToIdleTracker.get(pid)?.updateSessionId(sessionId);

            const awaiter = pidToAwaiter.get(pid);
            if (awaiter) {
                pidToAwaiter.delete(pid);
                awaiter(existingSession);
                logger.debug(`[RUNNER RUN] Resolved session awaiter for PID ${pid}`);
            }
            return;
        }

        if (!existingSession) {
            const trackedSession: TrackedSession = {
                startedBy: 'hapi directly - likely by user from terminal',
                happySessionId: sessionId,
                happySessionMetadataFromLocalWebhook: sessionMetadata,
                pid
            };
            pidToTrackedSession.set(pid, trackedSession);
            logger.debug(`[RUNNER RUN] Registered externally-started session ${sessionId}`);
            // No idle tracker for user-initiated sessions
        }
    };

    const onChildExited = (pid: number): void => {
        logger.debug(`[RUNNER RUN] Removing exited process PID ${pid} from tracking`);
        pidToTrackedSession.delete(pid);
        disposeIdleTracker(pid);
    };

    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
        logger.debugLargeJson('[RUNNER RUN] Spawning session', options);

        // --- Max active sessions cap ---
        pruneDeadEntries();
        const activeCount = countActiveRunnerSessions();
        if (activeCount >= MAX_ACTIVE_SESSIONS) {
            const errorMessage = `Max active runner sessions reached (${activeCount}/${MAX_ACTIVE_SESSIONS}). `
                + `Stop an existing session or increase HAPI_RUNNER_MAX_ACTIVE_SESSIONS.`;
            logger.debug(`[RUNNER RUN] ${errorMessage}`);
            return { type: 'error', errorMessage };
        }

        const { directory, approvedNewDirectoryCreation = true } = options;
        const agent = options.agent ?? 'claude';
        const yolo = options.yolo === true;
        const sessionType = options.sessionType ?? 'simple';
        const worktreeName = options.worktreeName;
        let directoryCreated = false;
        let spawnDirectory = directory;
        let worktreeInfo: WorktreeInfo | null = null;
        let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;

        if (sessionType === 'simple') {
            try {
                await fs.access(directory);
                logger.debug(`[RUNNER RUN] Directory exists: ${directory}`);
            } catch {
                logger.debug(`[RUNNER RUN] Directory doesn't exist, creating: ${directory}`);
                if (!approvedNewDirectoryCreation) {
                    logger.debug(`[RUNNER RUN] Directory creation not approved for: ${directory}`);
                    return {
                        type: 'requestToApproveDirectoryCreation',
                        directory
                    };
                }

                try {
                    await fs.mkdir(directory, { recursive: true });
                    logger.debug(`[RUNNER RUN] Successfully created directory: ${directory}`);
                    directoryCreated = true;
                } catch (mkdirError: any) {
                    let errorMessage = `Unable to create directory at '${directory}'. `;
                    if (mkdirError.code === 'EACCES') {
                        errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
                    } else if (mkdirError.code === 'ENOTDIR') {
                        errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
                    } else if (mkdirError.code === 'ENOSPC') {
                        errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
                    } else if (mkdirError.code === 'EROFS') {
                        errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
                    } else {
                        errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
                    }

                    logger.debug(`[RUNNER RUN] Directory creation failed: ${errorMessage}`);
                    return {
                        type: 'error',
                        errorMessage
                    };
                }
            }
        } else {
            try {
                await fs.access(directory);
                logger.debug(`[RUNNER RUN] Worktree base directory exists: ${directory}`);
            } catch {
                logger.debug(`[RUNNER RUN] Worktree base directory missing: ${directory}`);
                return {
                    type: 'error',
                    errorMessage: `${WORKTREE_REQUIRED_MESSAGE} Directory not found: ${directory}`
                };
            }
        }

        if (sessionType === 'worktree') {
            const worktreeResult = await createWorktree({
                basePath: directory,
                nameHint: worktreeName
            });
            if (!worktreeResult.ok) {
                logger.debug(`[RUNNER RUN] Worktree creation failed: ${worktreeResult.error}`);
                return {
                    type: 'error',
                    errorMessage: worktreeResult.error
                };
            }

            worktreeInfo = worktreeResult.info;
            spawnDirectory = worktreeInfo.worktreePath;
            logger.debug(`[RUNNER RUN] Created worktree ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch})`);
        }

        const cleanupWorktree = async () => {
            if (!worktreeInfo) {
                return;
            }
            const result = await removeWorktree({
                repoRoot: worktreeInfo.basePath,
                worktreePath: worktreeInfo.worktreePath
            });
            if (!result.ok) {
                logger.debug(`[RUNNER RUN] Failed to remove worktree ${worktreeInfo.worktreePath}: ${result.error}`);
            }
        };
        const maybeCleanupWorktree = async (reason: string) => {
            if (!worktreeInfo) {
                return;
            }
            const pid = happyProcess?.pid;
            if (pid && isProcessAlive(pid)) {
                logger.debug(`[RUNNER RUN] Skipping worktree cleanup after ${reason}; child still running`, {
                    pid,
                    worktreePath: worktreeInfo.worktreePath
                });
                return;
            }
            await cleanupWorktree();
        };

        let codexHomeDir: string | undefined;
        try {
            let extraEnv: Record<string, string> = {};
            if (options.token) {
                if (agent === 'codex') {
                    codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'hapi-codex-'));
                    await fs.writeFile(join(codexHomeDir, 'auth.json'), options.token, { mode: 0o600 });
                    extraEnv = {
                        CODEX_HOME: codexHomeDir
                    };
                } else if (agent === 'claude') {
                    extraEnv = {
                        CLAUDE_CODE_OAUTH_TOKEN: options.token
                    };
                }
            }

            if (worktreeInfo) {
                extraEnv = {
                    ...extraEnv,
                    HAPI_WORKTREE_BASE_PATH: worktreeInfo.basePath,
                    HAPI_WORKTREE_BRANCH: worktreeInfo.branch,
                    HAPI_WORKTREE_NAME: worktreeInfo.name,
                    HAPI_WORKTREE_PATH: worktreeInfo.worktreePath,
                    HAPI_WORKTREE_CREATED_AT: String(worktreeInfo.createdAt)
                };
            }

            const agentCommand = agent === 'codex'
                ? 'codex'
                : agent === 'gemini'
                    ? 'gemini'
                    : agent === 'opencode'
                        ? 'opencode'
                        : 'claude';
            const args = [agentCommand];
            if (options.resumeSessionId) {
                if (agent === 'codex') {
                    args.push('resume', options.resumeSessionId);
                } else {
                    args.push('--resume', options.resumeSessionId);
                }
            }
            args.push('--hapi-starting-mode', 'remote', '--started-by', 'runner');
            if (options.model && agent !== 'opencode') {
                args.push('--model', options.model);
            }
            if (yolo) {
                args.push('--yolo');
            }

            let stderrTail = '';
            const logStderrTail = () => {
                const trimmed = stderrTail.trim();
                if (!trimmed) {
                    return;
                }
                logger.debug('[RUNNER RUN] Child stderr tail', trimmed);
            };

            happyProcess = spawnHappyCLI(args, {
                cwd: spawnDirectory,
                // On Unix, detached=true keeps sessions alive across runner shutdown (no SIGHUP).
                // On Windows, detached=true can strip the console and break shell children.
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PATH: augmentPathWithToolManagers(process.env.PATH ?? ''),
                    ...extraEnv
                }
            });

            if (process.platform === 'win32') {
                happyProcess.unref();
            }

            happyProcess.stderr?.on('data', (data) => {
                stderrTail = appendTail(stderrTail, data);
            });

            if (!happyProcess.pid) {
                logger.debug('[RUNNER RUN] Failed to spawn process - no PID returned');
                await maybeCleanupWorktree('no-pid');
                return {
                    type: 'error',
                    errorMessage: 'Failed to spawn HAPI process - no PID returned'
                };
            }

            const pid = happyProcess.pid;
            logger.debug(`[RUNNER RUN] Spawned process with PID ${pid}`);

            const trackedSession: TrackedSession = {
                startedBy: 'runner',
                pid,
                childProcess: happyProcess,
                directoryCreated,
                message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
            };

            pidToTrackedSession.set(pid, trackedSession);

            // Create idle tracker for this runner-spawned session.
            // Session ID is not yet known; it will be set via updateSessionId
            // when the webhook arrives.
            const idleTracker = createIdleTrackerForSession(pid, undefined);

            // Wire stdout as an activity signal: agent terminal output resets idle clock
            happyProcess.stdout?.on('data', () => {
                idleTracker.touch();
            });

            happyProcess.on('exit', (code, signal) => {
                logger.debug(`[RUNNER RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
                if (code !== 0 || signal) {
                    logStderrTail();
                }
                onChildExited(pid);
            });

            happyProcess.on('error', (error) => {
                logger.debug('[RUNNER RUN] Child process error:', error);
                onChildExited(pid);
            });

            if (codexHomeDir) {
                const cleanupCodexHome = () => {
                    fs.rm(codexHomeDir!, { recursive: true, force: true }).catch(() => {});
                };
                happyProcess.on('exit', cleanupCodexHome);
                happyProcess.on('error', cleanupCodexHome);
            }

            logger.debug(`[RUNNER RUN] Waiting for session webhook for PID ${pid}`);

            const spawnResult = await new Promise<SpawnSessionResult>((resolve) => {
                const timeout = setTimeout(() => {
                    pidToAwaiter.delete(pid);
                    logger.debug(`[RUNNER RUN] Session webhook timeout for PID ${pid}`);
                    logStderrTail();
                    const stderrInfo = stderrTail.trim();
                    resolve({
                        type: 'error',
                        errorMessage: `Session webhook timeout for PID ${pid}${stderrInfo ? `\n--- stderr ---\n${stderrInfo.slice(0, 2000)}` : ' (no stderr output)'}`
                    });
                }, WEBHOOK_TIMEOUT_MS);

                pidToAwaiter.set(pid, (completedSession) => {
                    clearTimeout(timeout);
                    logger.debug(`[RUNNER RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
                    resolve({
                        type: 'success',
                        sessionId: completedSession.happySessionId!
                    });
                });
            });

            if (spawnResult.type !== 'success') {
                await maybeCleanupWorktree('spawn-error');
            }
            return spawnResult;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug('[RUNNER RUN] Failed to spawn session:', error);
            if (codexHomeDir) {
                await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
            }
            await maybeCleanupWorktree('exception');
            return {
                type: 'error',
                errorMessage: `Failed to spawn session: ${errorMessage}`
            };
        }
    };

    const forkSession = async (options: ForkSessionOptions): Promise<ForkSessionResult> => {
        logger.debugLargeJson('[RUNNER RUN] Forking session', options);

        const { path } = options;
        if (!path) {
            return {
                type: 'error',
                errorMessage: 'Path is required'
            };
        }

        try {
            let newSessionId: string;

            if (options.agent === 'claude') {
                const result = await forkClaudeSession({
                    sourceSessionId: options.sourceSessionId,
                    workingDirectory: path,
                    forkAtUuid: options.forkAtUuid,
                    forkAtMessageId: options.forkAtMessageId
                });
                newSessionId = result.newSessionId;
            } else if (options.agent === 'codex') {
                const result = await forkCodexSession({
                    sourceThreadId: options.sourceThreadId,
                    forkAtTurnId: options.forkAtTurnId
                });
                newSessionId = result.newSessionId;
            } else {
                const _exhaustive: never = options;
                return { type: 'error', errorMessage: `Fork not supported for agent: ${(_exhaustive as ForkSessionOptions).agent}` };
            }

            const spawnResult = await spawnSession({
                directory: path,
                resumeSessionId: newSessionId,
                agent: options.agent,
                model: options.model,
                yolo: options.yolo,
                sessionType: options.sessionType,
                worktreeName: options.worktreeName
            });

            if (spawnResult.type === 'requestToApproveDirectoryCreation') {
                return {
                    type: 'error',
                    errorMessage: `Unable to fork session because the directory does not exist: ${spawnResult.directory}`
                };
            }

            return spawnResult;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug('[RUNNER RUN] Failed to fork session:', error);
            return {
                type: 'error',
                errorMessage
            };
        }
    };

    const stopSession = (sessionId: string): boolean => {
        logger.debug(`[RUNNER RUN] Attempting to stop session ${sessionId}`);

        for (const [pid, session] of pidToTrackedSession.entries()) {
            const matchedPid = sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', ''));
            if (session.happySessionId !== sessionId && !matchedPid) {
                continue;
            }

            if (session.startedBy === 'runner' && session.childProcess) {
                try {
                    void killProcessByChildProcess(session.childProcess);
                    logger.debug(`[RUNNER RUN] Requested termination for runner-spawned session ${sessionId}`);
                } catch (error) {
                    logger.debug(`[RUNNER RUN] Failed to kill session ${sessionId}:`, error);
                }
            } else {
                try {
                    void killProcess(pid);
                    logger.debug(`[RUNNER RUN] Requested termination for external session PID ${pid}`);
                } catch (error) {
                    logger.debug(`[RUNNER RUN] Failed to kill external session PID ${pid}:`, error);
                }
            }

            pidToTrackedSession.delete(pid);
            disposeIdleTracker(pid);
            logger.debug(`[RUNNER RUN] Removed session ${sessionId} from tracking`);
            return true;
        }

        logger.debug(`[RUNNER RUN] Session ${sessionId} not found`);
        return false;
    };

    const pruneStaleSessions = () => {
        for (const [pid] of pidToTrackedSession.entries()) {
            if (!isProcessAlive(pid)) {
                logger.debug(`[RUNNER RUN] Removing stale session with PID ${pid} (process no longer exists)`);
                pidToTrackedSession.delete(pid);
                disposeIdleTracker(pid);
            }
        }
    };

    /**
     * Sweep runner-spawned orphans: sessions whose PIDs are dead but still
     * tracked, or runner-spawned sessions with no socket activity.
     * Runs once on call (for startup) and then on a periodic interval.
     */
    const startOrphanSweepLoop = (): (() => void) => {
        // Immediate sweep on startup
        pruneStaleSessions();
        logger.debug(`[RUNNER RUN] Orphan sweep started (interval ${ORPHAN_SWEEP_INTERVAL_MS}ms)`);

        orphanSweepInterval = setInterval(() => {
            pruneStaleSessions();
        }, ORPHAN_SWEEP_INTERVAL_MS);

        if (orphanSweepInterval.unref) {
            orphanSweepInterval.unref();
        }

        return () => {
            if (orphanSweepInterval) {
                clearInterval(orphanSweepInterval);
                orphanSweepInterval = null;
            }
        };
    };

    const dispose = (): void => {
        if (orphanSweepInterval) {
            clearInterval(orphanSweepInterval);
            orphanSweepInterval = null;
        }
        for (const [pid, tracker] of pidToIdleTracker.entries()) {
            tracker.dispose();
            pidToIdleTracker.delete(pid);
        }
    };

    return {
        getCurrentChildren,
        onHappySessionWebhook,
        spawnSession,
        forkSession,
        stopSession,
        pruneStaleSessions,
        touchSession,
        startOrphanSweepLoop,
        dispose
    };
}
