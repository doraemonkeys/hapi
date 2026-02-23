import type { SyncEvent } from '../sync/syncEngine'
import type { VisibilityState } from '../visibility/visibilityTracker'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export type SSESubscription = {
    id: string
    namespace: string
    all: boolean
    sessionId: string | null
    machineId: string | null
}

type SSESendFn = (event: SyncEvent, eventId: string) => void | Promise<void>

type SSEConnection = SSESubscription & {
    send: SSESendFn
    sendHeartbeat: () => void | Promise<void>
    /** Send a named SSE event (e.g. `sync-reset`) with no data. */
    sendNamedEvent: (eventName: string) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Ring buffer for event replay on reconnect
// ---------------------------------------------------------------------------

const DEFAULT_RING_BUFFER_CAPACITY = 500

type BufferedEvent = {
    id: number
    namespace: string | null
    event: SyncEvent
}

export class SSEManager {
    private readonly connections: Map<string, SSEConnection> = new Map()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private readonly heartbeatMs: number
    private readonly visibilityTracker: VisibilityTracker

    /** Monotonically increasing event counter. */
    private eventSequence = 0

    /** Bounded ring buffer of recent events for replay on reconnect. */
    private readonly ringBuffer: BufferedEvent[] = []
    private readonly ringBufferCapacity: number

    constructor(
        heartbeatMs = 30_000,
        visibilityTracker: VisibilityTracker,
        ringBufferCapacity = DEFAULT_RING_BUFFER_CAPACITY,
    ) {
        this.heartbeatMs = heartbeatMs
        this.visibilityTracker = visibilityTracker
        this.ringBufferCapacity = ringBufferCapacity
    }

    subscribe(options: {
        id: string
        namespace: string
        all?: boolean
        sessionId?: string | null
        machineId?: string | null
        visibility?: VisibilityState
        send: SSESendFn
        sendHeartbeat: () => void | Promise<void>
        sendNamedEvent: (eventName: string) => void | Promise<void>
    }): SSESubscription {
        const subscription: SSEConnection = {
            id: options.id,
            namespace: options.namespace,
            all: Boolean(options.all),
            sessionId: options.sessionId ?? null,
            machineId: options.machineId ?? null,
            send: options.send,
            sendHeartbeat: options.sendHeartbeat,
            sendNamedEvent: options.sendNamedEvent,
        }

        this.connections.set(subscription.id, subscription)
        this.visibilityTracker.registerConnection(
            subscription.id,
            subscription.namespace,
            options.visibility ?? 'hidden'
        )
        this.ensureHeartbeat()
        return {
            id: subscription.id,
            namespace: subscription.namespace,
            all: subscription.all,
            sessionId: subscription.sessionId,
            machineId: subscription.machineId
        }
    }

    unsubscribe(id: string): void {
        this.connections.delete(id)
        this.visibilityTracker.removeConnection(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
    }

    /**
     * Replay events missed during a disconnect window.
     *
     * If `lastEventId` is within the ring buffer, all subsequent events
     * matching the connection's subscription filters are replayed.
     * If not (too old or unknown), a `sync-reset` named event is sent
     * to signal the client to do a full state refetch via REST.
     *
     * @param upperBound  Only replay events with id <= upperBound.
     *   Pass the sequence captured *before* subscribing to avoid
     *   duplicating events that are also delivered via live broadcast.
     */
    async replayMissedEvents(
        connectionId: string,
        lastEventId: string,
        upperBound?: number,
    ): Promise<void> {
        const connection = this.connections.get(connectionId)
        if (!connection) return

        const requestedId = Number(lastEventId)
        if (!Number.isFinite(requestedId)) {
            await Promise.resolve(connection.sendNamedEvent('sync-reset'))
            return
        }

        // Stale ID from a previous server lifetime — client must full-refetch
        if (requestedId > this.eventSequence) {
            await Promise.resolve(connection.sendNamedEvent('sync-reset'))
            return
        }

        // Find the position in the ring buffer after the requested ID
        const startIdx = this.ringBuffer.findIndex(entry => entry.id > requestedId)
        if (startIdx === -1) {
            // All buffered events are at or before requestedId — nothing to replay.
            return
        }

        // Verify the requested ID isn't older than the buffer's oldest entry
        const oldestBuffered = this.ringBuffer[0]
        if (oldestBuffered && requestedId < oldestBuffered.id - 1) {
            // Gap: buffer no longer contains the event after requestedId
            await Promise.resolve(connection.sendNamedEvent('sync-reset'))
            return
        }

        for (let i = startIdx; i < this.ringBuffer.length; i++) {
            const entry = this.ringBuffer[i]!
            // Stop at the upper bound to avoid duplicating live broadcasts
            if (upperBound != null && entry.id > upperBound) {
                break
            }
            // Reconstruct a pseudo-event to check subscription filters
            if (!this.shouldSend(connection, entry.event)) {
                continue
            }
            await Promise.resolve(connection.send(entry.event, String(entry.id)))
        }
    }

    async sendToast(namespace: string, event: Extract<SyncEvent, { type: 'toast' }>): Promise<number> {
        const eventId = this.nextEventId()
        this.bufferEvent(namespace, event, eventId)

        const deliveries: Array<Promise<{ id: string; ok: boolean }>> = []
        for (const connection of this.connections.values()) {
            if (connection.namespace !== namespace) {
                continue
            }
            if (!this.visibilityTracker.isVisibleConnection(connection.id)) {
                continue
            }

            deliveries.push(
                Promise.resolve(connection.send(event, String(eventId)))
                    .then(() => ({ id: connection.id, ok: true }))
                    .catch(() => ({ id: connection.id, ok: false }))
            )
        }

        if (deliveries.length === 0) {
            return 0
        }

        const results = await Promise.all(deliveries)
        let successCount = 0
        for (const result of results) {
            if (result.ok) {
                successCount += 1
                continue
            }
            this.unsubscribe(result.id)
        }

        return successCount
    }

    broadcast(event: SyncEvent): void {
        const eventId = this.nextEventId()
        const namespace = 'namespace' in event ? (event as { namespace?: string }).namespace ?? null : null
        this.bufferEvent(namespace, event, eventId)

        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            void Promise.resolve(connection.send(event, String(eventId))).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    /** Current monotonic sequence number (for bounding replay). */
    getCurrentSequence(): number {
        return this.eventSequence
    }

    stop(): void {
        this.stopHeartbeat()
        for (const id of this.connections.keys()) {
            this.visibilityTracker.removeConnection(id)
        }
        this.connections.clear()
    }

    // -----------------------------------------------------------------------
    // Ring buffer internals
    // -----------------------------------------------------------------------

    private nextEventId(): number {
        return ++this.eventSequence
    }

    private bufferEvent(namespace: string | null, event: SyncEvent, id: number): void {
        if (this.ringBuffer.length >= this.ringBufferCapacity) {
            this.ringBuffer.shift()
        }
        this.ringBuffer.push({ id, namespace, event })
    }

    // -----------------------------------------------------------------------
    // Heartbeat
    // -----------------------------------------------------------------------

    private ensureHeartbeat(): void {
        if (this.heartbeatTimer || this.heartbeatMs <= 0) {
            return
        }

        this.heartbeatTimer = setInterval(() => {
            for (const connection of this.connections.values()) {
                void Promise.resolve(connection.sendHeartbeat()).catch(() => {
                    this.unsubscribe(connection.id)
                })
            }
        }, this.heartbeatMs)
    }

    private stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return
        }

        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    // -----------------------------------------------------------------------
    // Subscription filter
    // -----------------------------------------------------------------------

    private shouldSend(connection: SSEConnection, event: SyncEvent): boolean {
        if (event.type !== 'connection-changed') {
            const eventNamespace = event.namespace
            if (!eventNamespace || eventNamespace !== connection.namespace) {
                return false
            }
        }

        if (event.type === 'message-received') {
            return connection.sessionId === event.sessionId
        }

        if (event.type === 'connection-changed') {
            return true
        }

        if (connection.all) {
            return true
        }

        if ('sessionId' in event && connection.sessionId === event.sessionId) {
            return true
        }

        if ('machineId' in event && connection.machineId === event.machineId) {
            return true
        }

        return false
    }
}
