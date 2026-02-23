/**
 * In-memory sliding window rate limiter.
 *
 * Tracks per-key operation timestamps within a configurable time window.
 * Supports adaptive limits that scale with known active session count,
 * allowing legitimate reconnect bursts after network recovery while
 * still bounding storm pressure.
 *
 * Auto-cleans expired entries to prevent memory leak.
 */

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_BASE_LIMIT = 20

/** Scale factor: each active session adds this many extra allowed operations */
const DEFAULT_SESSION_SCALE_FACTOR = 2

/** Interval at which stale keys are purged from the window map */
const CLEANUP_INTERVAL_MS = 5 * 60_000

export type RateLimiterOptions = {
    /** Sliding window duration in milliseconds */
    windowMs?: number
    /** Base operation limit per key per window (before adaptive scaling) */
    baseLimit?: number
    /** Per-active-session scaling factor added to baseLimit */
    sessionScaleFactor?: number
}

export type RateLimitResult = {
    allowed: boolean
    /** Current operation count within the window (after recording, if allowed) */
    count: number
    /** Effective limit that was applied */
    limit: number
}

export class RateLimiter {
    private readonly windowMs: number
    private readonly baseLimit: number
    private readonly sessionScaleFactor: number

    /** Map from key -> sorted array of timestamps within the current window */
    private readonly windows = new Map<string, number[]>()
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    constructor(options?: RateLimiterOptions) {
        this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
        this.baseLimit = options?.baseLimit ?? DEFAULT_BASE_LIMIT
        this.sessionScaleFactor = options?.sessionScaleFactor ?? DEFAULT_SESSION_SCALE_FACTOR
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)

        // Allow the timer to not keep the process alive
        if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
            this.cleanupTimer.unref()
        }
    }

    /**
     * Check whether an operation for `key` is allowed and, if so, record it.
     *
     * @param key Isolation key (machineId, namespace, sessionId, etc.)
     * @param activeSessionCount Optional; scales the effective limit via
     *        `baseLimit + sessionScaleFactor * activeSessionCount`
     */
    check(key: string, activeSessionCount?: number): RateLimitResult {
        const now = Date.now()
        const cutoff = now - this.windowMs
        const limit = this.effectiveLimit(activeSessionCount)

        let timestamps = this.windows.get(key)
        if (timestamps) {
            // Evict entries older than the window
            const firstValid = timestamps.findIndex(t => t > cutoff)
            if (firstValid === -1) {
                timestamps = []
            } else if (firstValid > 0) {
                timestamps = timestamps.slice(firstValid)
            }
        } else {
            timestamps = []
        }

        if (timestamps.length >= limit) {
            this.windows.set(key, timestamps)
            return { allowed: false, count: timestamps.length, limit }
        }

        timestamps.push(now)
        this.windows.set(key, timestamps)
        return { allowed: true, count: timestamps.length, limit }
    }

    /** Compute effective limit: baseLimit + sessionScaleFactor * activeSessionCount */
    effectiveLimit(activeSessionCount?: number): number {
        const sessions = activeSessionCount != null && activeSessionCount > 0 ? activeSessionCount : 0
        return this.baseLimit + this.sessionScaleFactor * sessions
    }

    /** Return current window count for a key (without recording) */
    peek(key: string): number {
        const now = Date.now()
        const cutoff = now - this.windowMs
        const timestamps = this.windows.get(key)
        if (!timestamps) {
            return 0
        }
        let count = 0
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] > cutoff) {
                count++
            } else {
                break
            }
        }
        return count
    }

    /** Remove expired entries across all keys; called periodically by cleanup timer */
    cleanup(): void {
        const cutoff = Date.now() - this.windowMs
        for (const [key, timestamps] of this.windows) {
            const firstValid = timestamps.findIndex(t => t > cutoff)
            if (firstValid === -1) {
                this.windows.delete(key)
            } else if (firstValid > 0) {
                this.windows.set(key, timestamps.slice(firstValid))
            }
        }
    }

    /** Tear down the background cleanup timer (for graceful shutdown / tests) */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }
}
