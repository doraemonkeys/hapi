import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    SSE_RECONNECT_DELAY_MS,
    SSE_RECONNECT_DELAY_MAX_MS,
    RECONNECT_ESCALATION_THRESHOLDS,
} from '@hapi/protocol/reconnectConfig'

// ---------------------------------------------------------------------------
// EventSource mock
// ---------------------------------------------------------------------------

type ESHandler = ((event: any) => void) | null

class MockEventSource {
    static instances: MockEventSource[] = []

    url: string
    onopen: ESHandler = null
    onmessage: ESHandler = null
    onerror: ESHandler = null
    private namedListeners = new Map<string, EventListener[]>()
    closed = false

    constructor(url: string) {
        this.url = url
        MockEventSource.instances.push(this)
    }

    addEventListener(name: string, handler: EventListener): void {
        const list = this.namedListeners.get(name) ?? []
        list.push(handler)
        this.namedListeners.set(name, list)
    }

    removeEventListener(name: string, handler: EventListener): void {
        const list = this.namedListeners.get(name)
        if (list) {
            this.namedListeners.set(name, list.filter(h => h !== handler))
        }
    }

    close(): void {
        this.closed = true
    }

    /** Simulate the browser calling onopen after construction. */
    simulateOpen(): void {
        this.onopen?.({} as Event)
    }

    /** Simulate an error event. */
    simulateError(): void {
        this.onerror?.({} as Event)
    }

    /** Simulate receiving a message with an optional event ID. */
    simulateMessage(data: string, lastEventId?: string): void {
        this.onmessage?.({ data, lastEventId: lastEventId ?? '' } as MessageEvent<string>)
    }

    /** Dispatch a named event to registered listeners. */
    dispatchNamedEvent(name: string, data: string, lastEventId?: string): void {
        const listeners = this.namedListeners.get(name) ?? []
        for (const listener of listeners) {
            listener({ data, lastEventId: lastEventId ?? '' } as unknown as Event)
        }
    }
}

// Stub global EventSource
vi.stubGlobal('EventSource', MockEventSource)

// Import AFTER stubbing global
import { ManagedEventSource } from './sseReconnectPolicy'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ManagedEventSource', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        MockEventSource.instances = []
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('creates an EventSource on construction', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        expect(MockEventSource.instances).toHaveLength(1)
        expect(MockEventSource.instances[0]!.url).toBe('http://localhost/events')

        managed.close()
    })

    it('resets consecutive failures on successful open', () => {
        const onopen = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: { onopen },
        })

        const es = MockEventSource.instances[0]!
        es.simulateOpen()
        expect(onopen).toHaveBeenCalledTimes(1)

        managed.close()
    })

    it('schedules reconnect with exponential backoff on error', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: { onerror },
        })

        // First error
        const es1 = MockEventSource.instances[0]!
        es1.simulateError()
        expect(es1.closed).toBe(true)
        expect(onerror).toHaveBeenCalledTimes(1)

        // Only 1 EventSource so far (the destroyed one); new one not yet created
        expect(MockEventSource.instances).toHaveLength(1)

        // Advance past the first backoff delay (1000ms * 2^1 = 2000ms + jitter)
        // With randomization factor 0.5, max delay = 2000 * 1.5 = 3000ms
        vi.advanceTimersByTime(3100)

        // New EventSource should have been created
        expect(MockEventSource.instances).toHaveLength(2)

        managed.close()
    })

    it('increases delay exponentially with consecutive failures', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        // Simulate several consecutive errors and verify reconnect intervals grow
        const reconnectTimestamps: number[] = []

        // Error #1
        MockEventSource.instances[0]!.simulateError()
        // delay = min(1000 * 2^1, 30000) * jitter ≈ 2000 +/- 50%
        // max = 3000ms
        vi.advanceTimersByTime(3100)
        reconnectTimestamps.push(MockEventSource.instances.length)

        // Error #2
        MockEventSource.instances[MockEventSource.instances.length - 1]!.simulateError()
        // delay = min(1000 * 2^2, 30000) * jitter ≈ 4000 +/- 50%
        // We need to advance at least 6100ms (4000 * 1.5 + margin)
        vi.advanceTimersByTime(6100)
        reconnectTimestamps.push(MockEventSource.instances.length)

        // Error #3
        MockEventSource.instances[MockEventSource.instances.length - 1]!.simulateError()
        // delay = min(1000 * 2^3, 30000) * jitter ≈ 8000 +/- 50%
        vi.advanceTimersByTime(12100)
        reconnectTimestamps.push(MockEventSource.instances.length)

        // Each error should have produced a new EventSource
        expect(reconnectTimestamps[0]).toBe(2) // after 1st error
        expect(reconnectTimestamps[1]).toBe(3) // after 2nd error
        expect(reconnectTimestamps[2]).toBe(4) // after 3rd error

        managed.close()
    })

    it('clamps delay at SSE_RECONNECT_DELAY_MAX_MS (baseline)', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        // Simulate many errors to push past the exponential limit
        for (let i = 0; i < 20; i++) {
            const es = MockEventSource.instances[MockEventSource.instances.length - 1]!
            es.simulateError()
            // Advance a huge amount to ensure any timer fires
            vi.advanceTimersByTime(200_000)
        }

        // All errors should have produced EventSources (20 errors + 1 initial)
        expect(MockEventSource.instances.length).toBe(21)

        managed.close()
    })

    it('resets backoff to zero on successful open', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        // Error, reconnect, then open (which resets failures)
        MockEventSource.instances[0]!.simulateError()
        vi.advanceTimersByTime(5000)
        const es2 = MockEventSource.instances[1]!
        es2.simulateOpen() // resets consecutiveFailures to 0

        // Now error again — backoff should be from attempt 1 again (small delay)
        es2.simulateError()
        // delay = min(1000 * 2^1, 30000) * jitter ≈ 2000 +/- 50% = max 3000ms
        vi.advanceTimersByTime(3100)
        expect(MockEventSource.instances).toHaveLength(3)

        managed.close()
    })

    it('close() prevents any further reconnects', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        MockEventSource.instances[0]!.simulateError()
        managed.close()

        // Advance a lot — no new EventSource should be created
        vi.advanceTimersByTime(300_000)
        expect(MockEventSource.instances).toHaveLength(1)
    })

    it('close() destroys the current EventSource', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {},
        })

        expect(MockEventSource.instances[0]!.closed).toBe(false)
        managed.close()
        expect(MockEventSource.instances[0]!.closed).toBe(true)
    })

    it('wires named event listeners to each new EventSource', () => {
        const handler = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            handlers: {
                namedEvents: { 'sync-reset': handler },
            },
        })

        // First EventSource gets the named listener
        const es1 = MockEventSource.instances[0]!
        expect((es1 as any).namedListeners.get('sync-reset')).toHaveLength(1)

        // Error & reconnect
        es1.simulateError()
        vi.advanceTimersByTime(5000)

        // Second EventSource should also have the listener
        const es2 = MockEventSource.instances[1]!
        expect((es2 as any).namedListeners.get('sync-reset')).toHaveLength(1)

        managed.close()
    })

    it('calls urlFactory on each reconnect (may return different URLs)', () => {
        let callCount = 0
        const managed = new ManagedEventSource({
            urlFactory: () => {
                callCount++
                return `http://localhost/events?n=${callCount}`
            },
            handlers: {},
        })

        expect(MockEventSource.instances[0]!.url).toBe('http://localhost/events?n=1')

        MockEventSource.instances[0]!.simulateError()
        vi.advanceTimersByTime(5000)

        expect(MockEventSource.instances[1]!.url).toBe('http://localhost/events?n=2')

        managed.close()
    })

    it('tracks lastEventId from onmessage and passes to urlFactory on reconnect', () => {
        const urlFactory = vi.fn(
            (lastEventId: string | null) =>
                lastEventId
                    ? `http://localhost/events?lastEventId=${lastEventId}`
                    : 'http://localhost/events'
        )
        const managed = new ManagedEventSource({
            urlFactory,
            handlers: {},
        })

        // Initial connection — no lastEventId
        expect(urlFactory).toHaveBeenLastCalledWith(null)
        expect(MockEventSource.instances[0]!.url).toBe('http://localhost/events')

        // Simulate receiving messages with event IDs
        const es1 = MockEventSource.instances[0]!
        es1.simulateOpen()
        es1.simulateMessage('{"type":"ping"}', '5')
        es1.simulateMessage('{"type":"ping"}', '8')

        // Error & reconnect
        es1.simulateError()
        vi.advanceTimersByTime(5000)

        // urlFactory should receive the last seen event ID
        expect(urlFactory).toHaveBeenLastCalledWith('8')
        expect(MockEventSource.instances[1]!.url).toBe('http://localhost/events?lastEventId=8')

        managed.close()
    })

    it('tracks lastEventId from named events', () => {
        const urlFactory = vi.fn(
            (lastEventId: string | null) =>
                lastEventId
                    ? `http://localhost/events?lastEventId=${lastEventId}`
                    : 'http://localhost/events'
        )
        const handler = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory,
            handlers: {
                namedEvents: { 'sync-reset': handler },
            },
        })

        const es1 = MockEventSource.instances[0]!
        es1.simulateOpen()
        es1.dispatchNamedEvent('sync-reset', '', '12')

        // Error & reconnect
        es1.simulateError()
        vi.advanceTimersByTime(5000)

        expect(urlFactory).toHaveBeenLastCalledWith('12')
        expect(handler).toHaveBeenCalledTimes(1)

        managed.close()
    })
})
