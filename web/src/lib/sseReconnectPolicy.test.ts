import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    SSE_RECONNECT_DELAY_MS,
    SSE_RECONNECT_DELAY_MAX_MS,
    SSE_LIVENESS_TIMEOUT_MS,
    RECONNECT_ESCALATION_THRESHOLDS,
} from '@hapi/protocol/reconnectConfig'

// ---------------------------------------------------------------------------
// EventSourcePlus mock — vi.hoisted ensures the class is available when
// vi.mock factory runs (hoisted to file top by vitest).
// ---------------------------------------------------------------------------

type ListenHooks = {
    onMessage: (message: { data: string; event: string; id?: string }) => void
    onResponse?: (ctx: { response: { status: number } }) => void
    onRequestError?: (ctx: { error: Error }) => void
    onResponseError?: (ctx: { response: { status: number } }) => void
}

const { MockController, MockEventSourcePlus } = vi.hoisted(() => {
    class MockController {
        aborted = false
        abort(): void {
            this.aborted = true
        }
        reconnect(): void {
            // no-op for mock
        }
    }

    class MockEventSourcePlus {
        static instances: MockEventSourcePlus[] = []

        url: string
        options: Record<string, unknown>
        hooks: ListenHooks | null = null
        controller: MockController | null = null

        constructor(url: string, options?: Record<string, unknown>) {
            this.url = url
            this.options = options ?? {}
            MockEventSourcePlus.instances.push(this)
        }

        listen(hooks: ListenHooks): MockController {
            this.hooks = hooks
            this.controller = new MockController()
            return this.controller
        }

        // --- Simulation helpers ---

        simulateOpen(): void {
            this.hooks?.onResponse?.({ response: { status: 200 } })
        }

        simulateRequestError(): void {
            this.hooks?.onRequestError?.({ error: new Error('network') })
        }

        simulateResponseError(status: number): void {
            this.hooks?.onResponseError?.({ response: { status } })
        }

        simulateMessage(data: string, event = 'message', id?: string): void {
            this.hooks?.onMessage?.({ data, event, id })
        }
    }

    return { MockController, MockEventSourcePlus }
})

vi.mock('event-source-plus', () => ({
    EventSourcePlus: MockEventSourcePlus,
}))

// Import AFTER mocking
import { ManagedEventSource } from './sseReconnectPolicy'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestInstance(): InstanceType<typeof MockEventSourcePlus> {
    return MockEventSourcePlus.instances[MockEventSourcePlus.instances.length - 1]!
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ManagedEventSource', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        MockEventSourcePlus.instances = []
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('creates an EventSourcePlus on construction', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok-1',
            handlers: {},
        })

        expect(MockEventSourcePlus.instances).toHaveLength(1)
        expect(MockEventSourcePlus.instances[0]!.url).toBe('http://localhost/events')

        managed.close()
    })

    it('onOpen (onResponse) resets consecutive failures', () => {
        const onopen = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onopen },
        })

        latestInstance().simulateOpen()
        expect(onopen).toHaveBeenCalledTimes(1)

        managed.close()
    })

    it('401 response calls onunauthorized without scheduling reconnect', () => {
        const onunauthorized = vi.fn()
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onunauthorized, onerror },
        })

        latestInstance().simulateResponseError(401)
        expect(onunauthorized).toHaveBeenCalledTimes(1)
        expect(onerror).not.toHaveBeenCalled()

        // Controller should be aborted
        expect(MockEventSourcePlus.instances[0]!.controller!.aborted).toBe(true)

        // No reconnect even after waiting a long time
        vi.advanceTimersByTime(300_000)
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        managed.close()
    })

    it('non-401 response error triggers normal backoff reconnect', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        latestInstance().simulateResponseError(500)
        expect(onerror).toHaveBeenCalledTimes(1)

        // Only 1 instance so far; new one not yet created
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        // Advance past the first backoff (1000ms * 2^1 = 2000ms + jitter max ~3000ms)
        vi.advanceTimersByTime(3100)
        expect(MockEventSourcePlus.instances).toHaveLength(2)

        managed.close()
    })

    it('4xx (non-401) response calls onfatalerror without scheduling reconnect', () => {
        const onfatalerror = vi.fn()
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onfatalerror, onerror },
        })

        latestInstance().simulateResponseError(404)
        expect(onfatalerror).toHaveBeenCalledTimes(1)
        expect(onfatalerror).toHaveBeenCalledWith(404)
        expect(onerror).not.toHaveBeenCalled()

        // Controller should be aborted
        expect(MockEventSourcePlus.instances[0]!.controller!.aborted).toBe(true)

        // No reconnect even after waiting a long time
        vi.advanceTimersByTime(300_000)
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        managed.close()
    })

    it('403 response calls onfatalerror without scheduling reconnect', () => {
        const onfatalerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onfatalerror },
        })

        latestInstance().simulateResponseError(403)
        expect(onfatalerror).toHaveBeenCalledTimes(1)
        expect(onfatalerror).toHaveBeenCalledWith(403)

        vi.advanceTimersByTime(300_000)
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        managed.close()
    })

    it('request error triggers normal backoff reconnect', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        latestInstance().simulateRequestError()
        expect(onerror).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(3100)
        expect(MockEventSourcePlus.instances).toHaveLength(2)

        managed.close()
    })

    it('tokenFactory is called on each reconnect', async () => {
        let tokenCounter = 0
        const tokenFactory = vi.fn(() => `tok-${++tokenCounter}`)
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory,
            handlers: {},
        })

        // Headers factory is async/lazy — not called during construction
        expect(tokenFactory).toHaveBeenCalledTimes(0)

        // Resolve the async headers factory from the first instance
        const inst1 = MockEventSourcePlus.instances[0]!
        const headersFn1 = inst1.options.headers as () => Promise<Record<string, string>>
        const headers1 = await headersFn1()
        expect(headers1.Authorization).toBe('Bearer tok-1')

        // Trigger error + reconnect
        inst1.simulateRequestError()
        vi.advanceTimersByTime(5000)

        expect(MockEventSourcePlus.instances).toHaveLength(2)

        // Second instance gets a fresh token
        const inst2 = MockEventSourcePlus.instances[1]!
        const headersFn2 = inst2.options.headers as () => Promise<Record<string, string>>
        const headers2 = await headersFn2()
        expect(headers2.Authorization).toBe('Bearer tok-2')

        managed.close()
    })

    it('named events are routed by event.event field', () => {
        const onmessage = vi.fn()
        const syncResetHandler = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {
                onmessage,
                namedEvents: { 'sync-reset': syncResetHandler },
            },
        })

        const inst = latestInstance()

        // Named event "sync-reset" goes to the named handler
        inst.simulateMessage('reset-payload', 'sync-reset', '10')
        expect(syncResetHandler).toHaveBeenCalledTimes(1)
        expect(syncResetHandler).toHaveBeenCalledWith({ data: 'reset-payload', event: 'sync-reset', id: '10' })
        expect(onmessage).not.toHaveBeenCalled()

        // Default "message" event goes to onmessage
        inst.simulateMessage('{"type":"ping"}', 'message', '11')
        expect(onmessage).toHaveBeenCalledTimes(1)
        expect(onmessage).toHaveBeenCalledWith({ data: '{"type":"ping"}', event: 'message', id: '11' })

        // Empty string event also goes to onmessage (fallback)
        inst.simulateMessage('{"type":"pong"}', '', '12')
        expect(onmessage).toHaveBeenCalledTimes(2)

        managed.close()
    })

    it('reconnect() destroys old connection and rebuilds immediately', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        expect(MockEventSourcePlus.instances).toHaveLength(1)
        const firstController = MockEventSourcePlus.instances[0]!.controller!

        managed.reconnect()

        // Old controller aborted, new instance created
        expect(firstController.aborted).toBe(true)
        expect(MockEventSourcePlus.instances).toHaveLength(2)

        managed.close()
    })

    it('reconnect() is a no-op after close()', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        managed.close()
        managed.reconnect()

        // No new instance created after close
        expect(MockEventSourcePlus.instances).toHaveLength(1)
    })

    it('increases delay exponentially with consecutive failures', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        const reconnectCounts: number[] = []

        // Error #1
        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(3100) // 1000*2^1 * 1.5 = 3000
        reconnectCounts.push(MockEventSourcePlus.instances.length)

        // Error #2
        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(6100) // 1000*2^2 * 1.5 = 6000
        reconnectCounts.push(MockEventSourcePlus.instances.length)

        // Error #3
        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(12100) // 1000*2^3 * 1.5 = 12000
        reconnectCounts.push(MockEventSourcePlus.instances.length)

        expect(reconnectCounts[0]).toBe(2) // after 1st error
        expect(reconnectCounts[1]).toBe(3) // after 2nd error
        expect(reconnectCounts[2]).toBe(4) // after 3rd error

        managed.close()
    })

    it('resets backoff to zero on successful open', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        // Error, reconnect, then open (reset failures)
        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(5000)
        latestInstance().simulateOpen() // resets consecutiveFailures to 0

        // Now error again — backoff should be from attempt 1 (small)
        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(3100) // 1000*2^1 * 1.5 = 3000
        expect(MockEventSourcePlus.instances).toHaveLength(3)

        managed.close()
    })

    it('close() prevents any further reconnects', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        latestInstance().simulateRequestError()
        managed.close()

        vi.advanceTimersByTime(300_000)
        expect(MockEventSourcePlus.instances).toHaveLength(1)
    })

    it('close() aborts the controller', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        expect(MockEventSourcePlus.instances[0]!.controller!.aborted).toBe(false)
        managed.close()
        expect(MockEventSourcePlus.instances[0]!.controller!.aborted).toBe(true)
    })

    it('clamps delay at SSE_RECONNECT_DELAY_MAX_MS (baseline)', () => {
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: {},
        })

        for (let i = 0; i < 20; i++) {
            latestInstance().simulateRequestError()
            vi.advanceTimersByTime(200_000)
        }

        // All errors should have produced instances (20 errors + 1 initial)
        expect(MockEventSourcePlus.instances.length).toBe(21)

        managed.close()
    })

    it('calls urlFactory on each reconnect', () => {
        let callCount = 0
        const managed = new ManagedEventSource({
            urlFactory: () => {
                callCount++
                return `http://localhost/events?n=${callCount}`
            },
            tokenFactory: () => 'tok',
            handlers: {},
        })

        expect(MockEventSourcePlus.instances[0]!.url).toBe('http://localhost/events?n=1')

        latestInstance().simulateRequestError()
        vi.advanceTimersByTime(5000)

        expect(MockEventSourcePlus.instances[1]!.url).toBe('http://localhost/events?n=2')

        managed.close()
    })

    it('tracks lastEventId from onMessage and passes to urlFactory on reconnect', () => {
        const urlFactory = vi.fn(
            (lastEventId: string | null) =>
                lastEventId
                    ? `http://localhost/events?lastEventId=${lastEventId}`
                    : 'http://localhost/events'
        )
        const managed = new ManagedEventSource({
            urlFactory,
            tokenFactory: () => 'tok',
            handlers: {},
        })

        expect(urlFactory).toHaveBeenLastCalledWith(null)
        expect(MockEventSourcePlus.instances[0]!.url).toBe('http://localhost/events')

        const inst = latestInstance()
        inst.simulateOpen()
        inst.simulateMessage('{"type":"ping"}', 'message', '5')
        inst.simulateMessage('{"type":"ping"}', 'message', '8')

        inst.simulateRequestError()
        vi.advanceTimersByTime(5000)

        expect(urlFactory).toHaveBeenLastCalledWith('8')
        expect(MockEventSourcePlus.instances[1]!.url).toBe('http://localhost/events?lastEventId=8')

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
            tokenFactory: () => 'tok',
            handlers: {
                namedEvents: { 'sync-reset': handler },
            },
        })

        const inst = latestInstance()
        inst.simulateOpen()
        inst.simulateMessage('', 'sync-reset', '12')

        inst.simulateRequestError()
        vi.advanceTimersByTime(5000)

        expect(urlFactory).toHaveBeenLastCalledWith('12')
        expect(handler).toHaveBeenCalledTimes(1)

        managed.close()
    })

    // -----------------------------------------------------------------------
    // Liveness watchdog
    // -----------------------------------------------------------------------

    it('triggers reconnect when no events arrive within liveness timeout', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        // Open the connection — starts the liveness timer
        latestInstance().simulateOpen()
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        // Advance just under the timeout — no reconnect yet
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS - 1)
        expect(MockEventSourcePlus.instances).toHaveLength(1)
        expect(onerror).not.toHaveBeenCalled()

        // Cross the threshold — watchdog fires
        vi.advanceTimersByTime(2)
        expect(onerror).toHaveBeenCalledTimes(1)
        expect(MockEventSourcePlus.instances[0]!.controller!.aborted).toBe(true)

        // After backoff delay, a new connection is created
        vi.advanceTimersByTime(5000)
        expect(MockEventSourcePlus.instances).toHaveLength(2)

        managed.close()
    })

    it('resets liveness timer on every received message', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        latestInstance().simulateOpen()

        // Advance to 80% of the timeout, then send a message to reset
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 0.8)
        latestInstance().simulateMessage('{"type":"heartbeat"}', 'message', '1')

        // Advance another 80% — still under the reset timeout
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 0.8)
        expect(onerror).not.toHaveBeenCalled()
        expect(MockEventSourcePlus.instances).toHaveLength(1)

        // Now let the full timeout elapse without another message
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS)
        expect(onerror).toHaveBeenCalledTimes(1)

        managed.close()
    })

    it('clears liveness timer on close()', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        latestInstance().simulateOpen()
        managed.close()

        // Advance well past the timeout — no watchdog should fire
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 3)
        expect(onerror).not.toHaveBeenCalled()
        expect(MockEventSourcePlus.instances).toHaveLength(1)
    })

    it('clears liveness timer on explicit reconnect()', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        latestInstance().simulateOpen()

        // Advance partway, then force reconnect
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 0.5)
        managed.reconnect()

        // The old liveness timer from the first connection should not fire
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 0.6)
        expect(onerror).not.toHaveBeenCalled()

        // New connection opened — 2 instances total
        expect(MockEventSourcePlus.instances).toHaveLength(2)

        managed.close()
    })

    it('does not start liveness timer after close', () => {
        const onerror = vi.fn()
        const managed = new ManagedEventSource({
            urlFactory: () => 'http://localhost/events',
            tokenFactory: () => 'tok',
            handlers: { onerror },
        })

        managed.close()

        // Even after a very long wait, no watchdog triggers reconnect
        vi.advanceTimersByTime(SSE_LIVENESS_TIMEOUT_MS * 10)
        expect(MockEventSourcePlus.instances).toHaveLength(1)
        expect(onerror).not.toHaveBeenCalled()
    })
})
