/**
 * Managed EventSource wrapper with exponential backoff.
 *
 * Browser-native EventSource auto-reconnects with no configurable
 * delay, which causes reconnect storms. This wrapper destroys the
 * EventSource on error and recreates it after an exponentially
 * increasing delay, using the same progressive escalation thresholds
 * as the socket.io reconnect policy.
 *
 * Because we destroy and recreate the EventSource instance on each
 * reconnect (to control backoff timing), the browser's built-in
 * `Last-Event-ID` header mechanism does not carry over. Instead, we
 * track the last received event ID internally and pass it as a query
 * parameter (`lastEventId`) on reconnect, enabling hub-side replay.
 */

import {
    SSE_RECONNECT_DELAY_MS,
    SSE_RECONNECT_DELAY_MAX_MS,
    SSE_RECONNECT_RANDOMIZATION_FACTOR,
    RECONNECT_ESCALATION_THRESHOLDS,
} from '@hapi/protocol/reconnectConfig'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SSEEventHandlers = {
    onmessage?: (event: MessageEvent<string>) => void
    onopen?: () => void
    onerror?: (event: Event) => void
    /** Named event listeners added via addEventListener. */
    namedEvents?: Record<string, (event: MessageEvent<string>) => void>
}

export type ManagedSSEOptions = {
    /** Returns the full EventSource URL (may vary per reconnect). */
    urlFactory: (lastEventId: string | null) => string
    handlers: SSEEventHandlers
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sorted escalation thresholds for efficient lookup. */
const SORTED_THRESHOLDS = Object.entries(RECONNECT_ESCALATION_THRESHOLDS)
    .map(([k, v]) => [Number(k), v] as const)
    .sort(([a], [b]) => a - b)

/**
 * Resolve the current max delay based on consecutive failure count.
 * Later thresholds override earlier ones; falls back to the baseline max.
 */
function resolveMaxDelay(consecutiveFailures: number): number {
    let max = SSE_RECONNECT_DELAY_MAX_MS
    for (const [threshold, delayMax] of SORTED_THRESHOLDS) {
        if (consecutiveFailures >= threshold) {
            max = delayMax
        }
    }
    return max
}

/**
 * Compute the next backoff delay with jitter.
 *
 * delay = min(baseDelay * 2^attempt, currentMax) * (1 +/- randomizationFactor)
 */
function computeDelay(consecutiveFailures: number): number {
    const currentMax = resolveMaxDelay(consecutiveFailures)
    const exponential = SSE_RECONNECT_DELAY_MS * Math.pow(2, consecutiveFailures)
    const clamped = Math.min(exponential, currentMax)
    const jitter = 1 + (Math.random() * 2 - 1) * SSE_RECONNECT_RANDOMIZATION_FACTOR
    return Math.round(clamped * jitter)
}

// ---------------------------------------------------------------------------
// ManagedEventSource
// ---------------------------------------------------------------------------

export class ManagedEventSource {
    private source: EventSource | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private consecutiveFailures = 0
    private closed = false
    private lastEventId: string | null = null

    private readonly urlFactory: (lastEventId: string | null) => string
    private readonly handlers: SSEEventHandlers

    constructor(options: ManagedSSEOptions) {
        this.urlFactory = options.urlFactory
        this.handlers = options.handlers
        this.open()
    }

    /** Permanently close the managed connection; no further reconnects. */
    close(): void {
        this.closed = true
        this.clearTimer()
        this.destroySource()
    }

    // -----------------------------------------------------------------------
    // Internal lifecycle
    // -----------------------------------------------------------------------

    private open(): void {
        if (this.closed) return

        const url = this.urlFactory(this.lastEventId)
        const es = new EventSource(url)
        this.source = es

        es.onopen = () => {
            this.consecutiveFailures = 0
            this.handlers.onopen?.()
        }

        es.onmessage = (event: MessageEvent<string>) => {
            if (event.lastEventId) {
                this.lastEventId = event.lastEventId
            }
            this.handlers.onmessage?.(event)
        }

        es.onerror = (event: Event) => {
            this.handlers.onerror?.(event)
            this.destroySource()
            this.scheduleReconnect()
        }

        // Named events
        if (this.handlers.namedEvents) {
            for (const [name, handler] of Object.entries(this.handlers.namedEvents)) {
                es.addEventListener(name, ((event: MessageEvent<string>) => {
                    if (event.lastEventId) {
                        this.lastEventId = event.lastEventId
                    }
                    handler(event)
                }) as EventListener)
            }
        }
    }

    private destroySource(): void {
        if (!this.source) return
        this.source.onopen = null
        this.source.onmessage = null
        this.source.onerror = null
        this.source.close()
        this.source = null
    }

    private scheduleReconnect(): void {
        if (this.closed) return
        this.consecutiveFailures += 1
        const delay = computeDelay(this.consecutiveFailures)
        this.timer = setTimeout(() => {
            this.timer = null
            this.open()
        }, delay)
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
