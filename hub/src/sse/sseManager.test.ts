import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SSEManager namespace filtering', () => {
    it('routes events to matching namespace', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all namespaces', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                received.push({ id: 'beta', event })
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.broadcast({ type: 'connection-changed', data: { status: 'connected' } })

        expect(received).toHaveLength(2)
        expect(received.map((entry) => entry.id).sort()).toEqual(['alpha', 'beta'])
    })

    it('sends toast only to visible connections in a namespace', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'visible', event })
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.subscribe({
            id: 'hidden',
            namespace: 'alpha',
            all: true,
            visibility: 'hidden',
            send: (event) => {
                received.push({ id: 'hidden', event })
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.subscribe({
            id: 'other',
            namespace: 'beta',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'other', event })
            },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        const toastEvent: Extract<SyncEvent, { type: 'toast' }> = {
            type: 'toast',
            data: {
                title: 'Test',
                body: 'Toast body',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        }

        const delivered = await manager.sendToast('alpha', toastEvent)

        expect(delivered).toBe(1)
        expect(received).toHaveLength(1)
        expect(received[0]?.id).toBe('visible')
    })
})

describe('SSEManager event ID and ring buffer', () => {
    it('assigns sequential event IDs to broadcast events', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const ids: string[] = []

        manager.subscribe({
            id: 'conn1',
            namespace: 'ns',
            all: true,
            send: (_event, eventId) => { ids.push(eventId) },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'ns' })

        expect(ids).toEqual(['1', '2', '3'])
    })

    it('replays missed events after reconnect with Last-Event-ID', async () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 100)
        const replayed: Array<{ event: SyncEvent; id: string }> = []

        // Broadcast a few events with no subscriber
        manager.subscribe({
            id: 'dummy',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'ns' })
        manager.unsubscribe('dummy')

        // "Reconnecting" client saw event 1, missed 2 and 3
        manager.subscribe({
            id: 'reconnected',
            namespace: 'ns',
            all: true,
            send: (event, eventId) => { replayed.push({ event, id: eventId }) },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        await manager.replayMissedEvents('reconnected', '1')

        expect(replayed).toHaveLength(2)
        expect(replayed[0]!.id).toBe('2')
        expect(replayed[1]!.id).toBe('3')
    })

    it('sends sync-reset when requested ID is older than buffer', async () => {
        // Buffer capacity of 2 — oldest events get evicted
        const manager = new SSEManager(0, new VisibilityTracker(), 2)
        const namedEvents: string[] = []

        // Fill and overflow the buffer
        manager.subscribe({
            id: 'dummy',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' }) // id=1 (evicted)
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' }) // id=2
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'ns' }) // id=3
        manager.unsubscribe('dummy')

        manager.subscribe({
            id: 'reconnected',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: (eventName) => { namedEvents.push(eventName) }
        })

        // Request replay from event 0 (before buffer start)
        await manager.replayMissedEvents('reconnected', '0')

        expect(namedEvents).toEqual(['sync-reset'])
    })

    it('sends sync-reset for non-numeric Last-Event-ID', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const namedEvents: string[] = []

        manager.subscribe({
            id: 'conn',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: (eventName) => { namedEvents.push(eventName) }
        })

        await manager.replayMissedEvents('conn', 'not-a-number')

        expect(namedEvents).toEqual(['sync-reset'])
    })

    it('respects subscription filters during replay', async () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 100)
        const replayed: SyncEvent[] = []

        // Broadcast events to different sessions
        manager.subscribe({
            id: 'dummy',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' })
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'ns' })
        manager.unsubscribe('dummy')

        // Subscribe with session filter — only s2
        manager.subscribe({
            id: 'filtered',
            namespace: 'ns',
            sessionId: 's2',
            send: (event) => { replayed.push(event) },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        await manager.replayMissedEvents('filtered', '0')

        expect(replayed).toHaveLength(1)
        expect((replayed[0] as { sessionId: string }).sessionId).toBe('s2')
    })

    it('getCurrentSequence returns current monotonic counter', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        expect(manager.getCurrentSequence()).toBe(0)

        manager.subscribe({
            id: 'conn',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' })
        expect(manager.getCurrentSequence()).toBe(1)

        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' })
        expect(manager.getCurrentSequence()).toBe(2)
    })

    it('sends sync-reset when requested ID is beyond current sequence (server restart)', async () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 100)
        const namedEvents: string[] = []

        // Simulate server restart: sequence is at 0, buffer is empty.
        // Broadcast a couple of events so sequence advances to 2.
        manager.subscribe({
            id: 'dummy',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' }) // id=1
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' }) // id=2
        manager.unsubscribe('dummy')

        // Client reconnects with a stale ID from the previous server lifetime
        manager.subscribe({
            id: 'stale-client',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: (eventName) => { namedEvents.push(eventName) }
        })

        await manager.replayMissedEvents('stale-client', '100')

        expect(namedEvents).toEqual(['sync-reset'])
    })

    it('sends sync-reset when requested ID exceeds sequence on empty buffer', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const namedEvents: string[] = []

        // Fresh server: sequence=0, buffer empty
        manager.subscribe({
            id: 'conn',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: (eventName) => { namedEvents.push(eventName) }
        })

        await manager.replayMissedEvents('conn', '50')

        expect(namedEvents).toEqual(['sync-reset'])
    })

    it('respects upperBound during replay to prevent duplicate delivery', async () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 100)

        // Populate ring buffer via a dummy subscriber
        manager.subscribe({
            id: 'dummy',
            namespace: 'ns',
            all: true,
            send: () => {},
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns' }) // id=1
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns' }) // id=2
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'ns' }) // id=3
        manager.broadcast({ type: 'session-updated', sessionId: 's4', namespace: 'ns' }) // id=4
        manager.unsubscribe('dummy')

        const replayed: Array<{ event: SyncEvent; id: string }> = []
        manager.subscribe({
            id: 'reconnected',
            namespace: 'ns',
            all: true,
            send: (event, eventId) => { replayed.push({ event, id: eventId }) },
            sendHeartbeat: () => {},
            sendNamedEvent: () => {}
        })

        // Replay from event 1, but cap at event 3 (event 4 will come via broadcast)
        await manager.replayMissedEvents('reconnected', '1', 3)

        expect(replayed).toHaveLength(2)
        expect(replayed[0]!.id).toBe('2')
        expect(replayed[1]!.id).toBe('3')
    })
})
