import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the logger before importing the module under test
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
    },
}))

import { applySocketReconnectPolicy, getReconnectStats } from './socketReconnectPolicy'
import type { ReconnectTelemetry } from './socketReconnectPolicy'
import {
    RECONNECT_DELAY_MAX_MS,
    RECONNECT_ESCALATION_THRESHOLDS,
    RECONNECT_SUMMARY_INTERVAL,
} from '@hapi/protocol'

// ---------------------------------------------------------------------------
// Fake socket.io Manager for testing
// ---------------------------------------------------------------------------

type ManagerHandler = (...args: unknown[]) => void

class FakeManager {
    private handlers = new Map<string, ManagerHandler[]>()
    private _delayMax = RECONNECT_DELAY_MAX_MS

    on(event: string, handler: ManagerHandler): this {
        const list = this.handlers.get(event) ?? []
        list.push(handler)
        this.handlers.set(event, list)
        return this
    }

    reconnectionDelayMax(value?: number): number {
        if (value !== undefined) {
            this._delayMax = value
        }
        return this._delayMax
    }

    /** Simulate emitting an event on the manager. */
    emit(event: string, ...args: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(...args)
        }
    }
}

function createFakeSocket(): { socket: any; manager: FakeManager } {
    const manager = new FakeManager()
    const socket = { io: manager } as any
    return { socket, manager }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applySocketReconnectPolicy (CLI)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('returns initial telemetry with zero counters and baseline delay max', () => {
        const { socket } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        expect(telemetry.consecutiveFailures).toBe(0)
        expect(telemetry.totalAttempts).toBe(0)
        expect(telemetry.disconnectedSince).toBeNull()
        expect(telemetry.longestDisconnectMs).toBe(0)
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
    })

    it('degrades gracefully when manager hooks are unavailable', async () => {
        const { logger } = await import('@/ui/logger')
        const mockDebug = vi.mocked(logger.debug)
        mockDebug.mockClear()

        const telemetry = applySocketReconnectPolicy({} as any, 'missing-manager')

        expect(telemetry.totalAttempts).toBe(0)
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
        expect(mockDebug).toHaveBeenCalledWith(
            '[missing-manager] Reconnect policy disabled: socket manager unavailable'
        )
    })

    it('increments totalAttempts and sets consecutiveFailures on reconnect_attempt', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        manager.emit('reconnect_attempt', 1)
        expect(telemetry.consecutiveFailures).toBe(1)
        expect(telemetry.totalAttempts).toBe(1)

        manager.emit('reconnect_attempt', 2)
        expect(telemetry.consecutiveFailures).toBe(2)
        expect(telemetry.totalAttempts).toBe(2)
    })

    it('marks disconnectedSince on first failure and does not overwrite on subsequent', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_attempt', 1)
        expect(telemetry.disconnectedSince).toBe(1000)

        vi.setSystemTime(new Date(2000))
        manager.emit('reconnect_attempt', 2)
        // Should still be the first timestamp
        expect(telemetry.disconnectedSince).toBe(1000)
    })

    it('escalates delay max at configured thresholds', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        const sortedThresholds = Object.entries(RECONNECT_ESCALATION_THRESHOLDS)
            .map(([k, v]) => [Number(k), v] as const)
            .sort((a, b) => a[0] - b[0])

        for (const [threshold, expectedDelayMax] of sortedThresholds) {
            manager.emit('reconnect_attempt', threshold)
            expect(telemetry.currentDelayMax).toBe(expectedDelayMax)
            expect(manager.reconnectionDelayMax()).toBe(expectedDelayMax)
        }
    })

    it('does not escalate delay max at non-threshold attempts', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        manager.emit('reconnect_attempt', 5)
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_DELAY_MAX_MS)

        manager.emit('reconnect_attempt', 19)
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
    })

    it('resets all counters and delay max on successful reconnect', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_attempt', 1)
        manager.emit('reconnect_attempt', 20)

        const escalatedDelay = telemetry.currentDelayMax
        expect(escalatedDelay).toBeGreaterThan(RECONNECT_DELAY_MAX_MS)

        vi.setSystemTime(new Date(5000))
        manager.emit('reconnect', 20)

        expect(telemetry.consecutiveFailures).toBe(0)
        expect(telemetry.disconnectedSince).toBeNull()
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_DELAY_MAX_MS)
    })

    it('tracks longest disconnect duration across multiple disconnect windows', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        // First disconnect window: 4s
        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_attempt', 1)
        vi.setSystemTime(new Date(5000))
        manager.emit('reconnect', 1)
        expect(telemetry.longestDisconnectMs).toBe(4000)

        // Second disconnect window: 2s (shorter, should not replace)
        vi.setSystemTime(new Date(6000))
        manager.emit('reconnect_attempt', 1)
        vi.setSystemTime(new Date(8000))
        manager.emit('reconnect', 1)
        expect(telemetry.longestDisconnectMs).toBe(4000)

        // Third disconnect window: 10s (longer, should replace)
        vi.setSystemTime(new Date(10000))
        manager.emit('reconnect_attempt', 1)
        vi.setSystemTime(new Date(20000))
        manager.emit('reconnect', 1)
        expect(telemetry.longestDisconnectMs).toBe(10000)
    })

    it('marks disconnected on reconnect_error', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'test')

        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_error', new Error('connection refused'))
        expect(telemetry.disconnectedSince).toBe(1000)
    })

    it('registers telemetry in the global stats registry', () => {
        const { socket } = createFakeSocket()
        applySocketReconnectPolicy(socket, 'my-socket')

        const stats = getReconnectStats()
        const entry = stats.find(s => s.label === 'my-socket')
        expect(entry).toBeDefined()
        expect(entry!.telemetry.totalAttempts).toBe(0)

        // Verify returned telemetry is a shallow copy: mutating it should
        // not affect subsequent getReconnectStats() calls
        entry!.telemetry.totalAttempts = 999
        const stats2 = getReconnectStats()
        const entry2 = stats2.find(s => s.label === 'my-socket')
        expect(entry2!.telemetry.totalAttempts).toBe(0)
    })

    it('fires periodic summary at RECONNECT_SUMMARY_INTERVAL', async () => {
        const { logger } = await import('@/ui/logger')
        const mockDebug = vi.mocked(logger.debug)
        mockDebug.mockClear()

        const { socket, manager } = createFakeSocket()
        applySocketReconnectPolicy(socket, 'summary-test')

        // Fire at the summary interval (not a log threshold)
        manager.emit('reconnect_attempt', RECONNECT_SUMMARY_INTERVAL)

        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining('Reconnect summary')
        )
    })

    it('dispose() removes telemetry from the global registry', () => {
        const { socket } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'dispose-test')

        const before = getReconnectStats()
        expect(before.some(s => s.label === 'dispose-test')).toBe(true)

        telemetry.dispose()

        const after = getReconnectStats()
        expect(after.some(s => s.label === 'dispose-test')).toBe(false)
    })

    it('dispose() is idempotent', () => {
        const { socket } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'idempotent-test')

        telemetry.dispose()
        telemetry.dispose() // should not throw

        const stats = getReconnectStats()
        expect(stats.some(s => s.label === 'idempotent-test')).toBe(false)
    })
})
