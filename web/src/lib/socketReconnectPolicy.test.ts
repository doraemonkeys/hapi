import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySocketReconnectPolicy } from './socketReconnectPolicy'
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

describe('applySocketReconnectPolicy (Web)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('returns initial telemetry with zero counters', () => {
        const { socket } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        expect(telemetry.consecutiveFailures).toBe(0)
        expect(telemetry.totalAttempts).toBe(0)
        expect(telemetry.disconnectedSince).toBeNull()
        expect(telemetry.longestDisconnectMs).toBe(0)
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
    })

    it('tracks consecutive failures and total attempts', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        manager.emit('reconnect_attempt', 1)
        manager.emit('reconnect_attempt', 2)
        manager.emit('reconnect_attempt', 3)

        expect(telemetry.consecutiveFailures).toBe(3)
        expect(telemetry.totalAttempts).toBe(3)
    })

    it('escalates delay max at configured thresholds', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        const sortedThresholds = Object.entries(RECONNECT_ESCALATION_THRESHOLDS)
            .map(([k, v]) => [Number(k), v] as const)
            .sort((a, b) => a[0] - b[0])

        for (const [threshold, expectedDelayMax] of sortedThresholds) {
            manager.emit('reconnect_attempt', threshold)
            expect(telemetry.currentDelayMax).toBe(expectedDelayMax)
            expect(manager.reconnectionDelayMax()).toBe(expectedDelayMax)
        }
    })

    it('resets telemetry and delay max on successful reconnect', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_attempt', 1)
        manager.emit('reconnect_attempt', 20)
        expect(telemetry.currentDelayMax).toBeGreaterThan(RECONNECT_DELAY_MAX_MS)

        vi.setSystemTime(new Date(5000))
        manager.emit('reconnect', 20)

        expect(telemetry.consecutiveFailures).toBe(0)
        expect(telemetry.disconnectedSince).toBeNull()
        expect(telemetry.currentDelayMax).toBe(RECONNECT_DELAY_MAX_MS)
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_DELAY_MAX_MS)
    })

    it('tracks longest disconnect duration', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        // 3s window
        vi.setSystemTime(new Date(1000))
        manager.emit('reconnect_attempt', 1)
        vi.setSystemTime(new Date(4000))
        manager.emit('reconnect', 1)
        expect(telemetry.longestDisconnectMs).toBe(3000)

        // 7s window (longer)
        vi.setSystemTime(new Date(5000))
        manager.emit('reconnect_attempt', 1)
        vi.setSystemTime(new Date(12000))
        manager.emit('reconnect', 1)
        expect(telemetry.longestDisconnectMs).toBe(7000)
    })

    it('does not overwrite disconnectedSince on subsequent attempts', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        vi.setSystemTime(new Date(100))
        manager.emit('reconnect_attempt', 1)
        expect(telemetry.disconnectedSince).toBe(100)

        vi.setSystemTime(new Date(500))
        manager.emit('reconnect_attempt', 2)
        expect(telemetry.disconnectedSince).toBe(100)
    })

    it('marks disconnected on reconnect_error', () => {
        const { socket, manager } = createFakeSocket()
        const telemetry = applySocketReconnectPolicy(socket, 'web-test')

        vi.setSystemTime(new Date(2000))
        manager.emit('reconnect_error', new Error('timeout'))
        expect(telemetry.disconnectedSince).toBe(2000)
    })

    it('options composition: shared config values drive socket manager behavior', () => {
        const { socket, manager } = createFakeSocket()
        applySocketReconnectPolicy(socket, 'web-test')

        // Verify the manager starts at baseline max
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_DELAY_MAX_MS)

        // After threshold 20, verify escalation from shared config
        manager.emit('reconnect_attempt', 20)
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_ESCALATION_THRESHOLDS[20])

        // Reset
        manager.emit('reconnect', 20)
        expect(manager.reconnectionDelayMax()).toBe(RECONNECT_DELAY_MAX_MS)
    })
})
