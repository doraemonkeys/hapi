/**
 * Managed SSE wrapper with exponential backoff, backed by EventSourcePlus.
 *
 * EventSourcePlus (fetch-based) replaces the browser-native EventSource to
 * enable Authorization headers — JWT no longer leaks via URL query params.
 *
 * Built-in retry in EventSourcePlus is disabled (maxRetryCount: 0); this
 * wrapper owns the full reconnect lifecycle with the same progressive
 * escalation thresholds used by the Socket.IO reconnect policy.
 *
 * Because we destroy and recreate the connection on each reconnect, the
 * last received event ID is tracked internally and passed as a query
 * parameter (`lastEventId`) on reconnect, enabling hub-side replay.
 */

import { EventSourcePlus, type EventSourceController } from 'event-source-plus'

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
    onmessage?: (event: { data: string; event: string; id?: string }) => void
    onopen?: () => void
    onerror?: () => void
    /** Called on 401 response; upstream should refresh token and call reconnect(). */
    onunauthorized?: () => void | Promise<void>
    /** Named event listeners — routed via the unified onMessage by event.event field. */
    namedEvents?: Record<string, (event: { data: string; event: string; id?: string }) => void>
}

export type ManagedSSEOptions = {
    /** Returns the full SSE URL (may vary per reconnect). */
    urlFactory: (lastEventId: string | null) => string
    /** Returns the current JWT — called on every connection attempt. */
    tokenFactory: () => string
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
    private controller: EventSourceController | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private consecutiveFailures = 0
    private closed = false
    private lastEventId: string | null = null

    private readonly urlFactory: (lastEventId: string | null) => string
    private readonly tokenFactory: () => string
    private readonly handlers: SSEEventHandlers

    constructor(options: ManagedSSEOptions) {
        this.urlFactory = options.urlFactory
        this.tokenFactory = options.tokenFactory
        this.handlers = options.handlers
        this.open()
    }

    /** Permanently close the managed connection; no further reconnects. */
    close(): void {
        this.closed = true
        this.clearTimer()
        this.destroySource()
    }

    /** Destroy current connection and immediately rebuild (e.g. after token refresh). */
    reconnect(): void {
        if (this.closed) return
        this.destroySource()
        this.clearTimer()
        this.open()
    }

    // -----------------------------------------------------------------------
    // Internal lifecycle
    // -----------------------------------------------------------------------

    private open(): void {
        if (this.closed) return

        const url = this.urlFactory(this.lastEventId)

        const sse = new EventSourcePlus(url, {
            headers: async () => ({
                Authorization: `Bearer ${this.tokenFactory()}`,
            }),
            // Disable library-internal retry — this wrapper owns reconnect lifecycle
            maxRetryCount: 0,
        })

        this.controller = sse.listen({
            onMessage: (message) => {
                if (message.id) {
                    this.lastEventId = message.id
                }

                // Named events: event-source-plus sends all event types through
                // onMessage. Route by message.event field; empty string or
                // "message" falls through to the default onmessage handler.
                const namedHandler =
                    message.event && message.event !== 'message'
                        ? this.handlers.namedEvents?.[message.event]
                        : undefined

                if (namedHandler) {
                    namedHandler(message)
                } else {
                    this.handlers.onmessage?.(message)
                }
            },
            onResponse: () => {
                this.consecutiveFailures = 0
                this.handlers.onopen?.()
            },
            onRequestError: () => {
                this.handlers.onerror?.()
                this.destroySource()
                this.scheduleReconnect()
            },
            onResponseError: ({ response }) => {
                if (response.status === 401) {
                    // Fire-and-forget: handler refreshes token asynchronously
                    // then calls reconnect() — we only destroy the current source.
                    this.handlers.onunauthorized?.()
                    this.destroySource()
                    return
                }
                this.handlers.onerror?.()
                this.destroySource()
                this.scheduleReconnect()
            },
        })
    }

    private destroySource(): void {
        this.controller?.abort()
        this.controller = null
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
