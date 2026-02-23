import { getDescendantCount, isProcessAlive } from '@/utils/process';
import { logger } from '@/ui/logger';

export type IdleExpiredCallback = (pid: number, sessionId: string | undefined) => void;

/**
 * Tracks activity for a single runner-spawned session and fires a callback
 * when the session has been continuously idle for longer than the configured TTL.
 *
 * "Idle" means no terminal I/O, RPC, or socket messages (excluding keepalive)
 * AND the child process has no active descendant processes (safety valve for
 * long-running builds/compilations).
 *
 * Single setInterval per session at TTL/2 granularity avoids per-event timer churn.
 */
export class IdleTracker {
    private lastTouchTime: number;
    private readonly checkInterval: ReturnType<typeof setInterval>;
    private disposed = false;

    constructor(
        private readonly pid: number,
        private sessionId: string | undefined,
        private readonly ttlMs: number,
        private readonly onExpired: IdleExpiredCallback
    ) {
        this.lastTouchTime = Date.now();

        // Check at half-TTL granularity: worst-case detection latency = TTL * 1.5
        const intervalMs = Math.max(ttlMs / 2, 1_000);
        this.checkInterval = setInterval(() => this.checkIdle(), intervalMs);

        // Prevent the interval from keeping the process alive during shutdown
        if (this.checkInterval.unref) {
            this.checkInterval.unref();
        }
    }

    /** Reset idle clock. Call from any qualifying activity source. */
    touch(): void {
        this.lastTouchTime = Date.now();
    }

    /** Update the tracked session ID when it becomes known after spawn. */
    updateSessionId(sessionId: string): void {
        this.sessionId = sessionId;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        clearInterval(this.checkInterval);
    }

    private checkIdle(): void {
        if (this.disposed) {
            return;
        }

        const elapsed = Date.now() - this.lastTouchTime;
        if (elapsed < this.ttlMs) {
            return;
        }

        // Safety valve: process still alive with active descendants = not idle.
        // Agents performing long builds spawn compilers/bundlers as children.
        if (!isProcessAlive(this.pid)) {
            // Process already dead; dispose silently, sessionManager will clean up
            this.dispose();
            return;
        }

        const descendants = getDescendantCount(this.pid);
        if (descendants > 0) {
            logger.debug(
                `[IDLE TRACKER] PID ${this.pid} idle for ${elapsed}ms but has ${descendants} descendant(s); skipping expiry`
            );
            return;
        }

        logger.debug(
            `[IDLE TRACKER] PID ${this.pid} (session ${this.sessionId ?? 'unknown'}) idle for ${elapsed}ms (TTL ${this.ttlMs}ms); firing expiry`
        );

        this.dispose();
        this.onExpired(this.pid, this.sessionId);
    }
}
