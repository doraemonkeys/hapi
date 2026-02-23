import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
vi.mock('@/utils/process', () => ({
    isProcessAlive: vi.fn(),
    getDescendantCount: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}))

import { IdleTracker } from './idleTracker'
import { isProcessAlive, getDescendantCount } from '@/utils/process'

const mockIsProcessAlive = vi.mocked(isProcessAlive)
const mockGetDescendantCount = vi.mocked(getDescendantCount)

describe('IdleTracker', () => {
    const TTL_MS = 10_000
    const TEST_PID = 12345

    beforeEach(() => {
        vi.useFakeTimers()
        mockIsProcessAlive.mockReturnValue(true)
        mockGetDescendantCount.mockReturnValue(0)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('fires onExpired after TTL elapses with no activity', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        // Check interval is TTL/2 = 5000ms; TTL itself is 10000ms
        // At 5000ms: elapsed = 5000 < 10000 → no fire
        vi.advanceTimersByTime(5000)
        expect(onExpired).not.toHaveBeenCalled()

        // At 10000ms: elapsed = 10000 >= 10000 → should fire
        vi.advanceTimersByTime(5000)
        expect(onExpired).toHaveBeenCalledOnce()
        expect(onExpired).toHaveBeenCalledWith(TEST_PID, 'session-1')

        tracker.dispose()
    })

    it('touch() resets the idle clock', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        // Interval fires at 5000ms multiples. Advance 8s (close to TTL).
        // Check at 5000ms: elapsed 5000 < 10000 → no fire.
        vi.advanceTimersByTime(8000)
        expect(onExpired).not.toHaveBeenCalled()

        // Touch resets the clock (lastTouchTime = 8000ms)
        tracker.touch()

        // Advance to 15000ms total. Check at 10000: elapsed 2000 < TTL.
        // Check at 15000: elapsed 7000 < TTL. Still no fire.
        vi.advanceTimersByTime(7000)
        expect(onExpired).not.toHaveBeenCalled()

        // Advance to 20000ms total. Check at 20000: elapsed 12000 >= TTL → fires.
        vi.advanceTimersByTime(5000)
        expect(onExpired).toHaveBeenCalledOnce()

        tracker.dispose()
    })

    it('does not fire if process has descendants (safety valve)', () => {
        const onExpired = vi.fn()
        mockGetDescendantCount.mockReturnValue(3)

        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        // Advance past TTL
        vi.advanceTimersByTime(11_000)
        expect(onExpired).not.toHaveBeenCalled()
        expect(mockGetDescendantCount).toHaveBeenCalledWith(TEST_PID)

        tracker.dispose()
    })

    it('disposes silently when process is dead', () => {
        const onExpired = vi.fn()
        mockIsProcessAlive.mockReturnValue(false)

        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        // Advance past TTL
        vi.advanceTimersByTime(11_000)
        // Should NOT fire onExpired (process is dead, tracker auto-disposes)
        expect(onExpired).not.toHaveBeenCalled()

        tracker.dispose()
    })

    it('dispose() stops the interval and prevents future expiry', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        tracker.dispose()

        // Advance way past TTL
        vi.advanceTimersByTime(100_000)
        expect(onExpired).not.toHaveBeenCalled()
    })

    it('dispose() is idempotent', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        tracker.dispose()
        tracker.dispose() // should not throw
        tracker.dispose()

        vi.advanceTimersByTime(100_000)
        expect(onExpired).not.toHaveBeenCalled()
    })

    it('updateSessionId changes the session ID passed to onExpired', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, undefined, TTL_MS, onExpired)

        tracker.updateSessionId('session-new')

        vi.advanceTimersByTime(11_000)
        expect(onExpired).toHaveBeenCalledWith(TEST_PID, 'session-new')

        tracker.dispose()
    })

    it('fires with undefined sessionId when none is set', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, undefined, TTL_MS, onExpired)

        vi.advanceTimersByTime(11_000)
        expect(onExpired).toHaveBeenCalledWith(TEST_PID, undefined)

        tracker.dispose()
    })

    it('check interval is at least 1000ms even for very small TTL', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', 100, onExpired)

        // With TTL=100, interval = max(50, 1000) = 1000ms
        // At 999ms: should not fire yet
        vi.advanceTimersByTime(999)
        expect(onExpired).not.toHaveBeenCalled()

        // At 1000ms: check fires, elapsed >= TTL → fire
        vi.advanceTimersByTime(1)
        expect(onExpired).toHaveBeenCalledOnce()

        tracker.dispose()
    })

    it('fires expiry once and then auto-disposes', () => {
        const onExpired = vi.fn()
        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        vi.advanceTimersByTime(11_000)
        expect(onExpired).toHaveBeenCalledOnce()

        // Further time should not cause another call (disposed)
        vi.advanceTimersByTime(50_000)
        expect(onExpired).toHaveBeenCalledOnce()
    })

    it('does not fire if descendants disappear after touch resets clock', () => {
        const onExpired = vi.fn()
        mockGetDescendantCount.mockReturnValue(2)

        const tracker = new IdleTracker(TEST_PID, 'session-1', TTL_MS, onExpired)

        // First check at 10000ms: descendants present → skip
        vi.advanceTimersByTime(11_000)
        expect(onExpired).not.toHaveBeenCalled()

        // Touch resets clock (lastTouchTime = 11000ms); descendants now gone
        tracker.touch()
        mockGetDescendantCount.mockReturnValue(0)

        // Next check at 15000ms: elapsed = 4000 < 10000 → no fire
        // Next check at 20000ms: elapsed = 9000 < 10000 → no fire
        vi.advanceTimersByTime(10_000)
        expect(onExpired).not.toHaveBeenCalled()

        // Check at 25000ms: elapsed = 14000 >= 10000 → fires
        vi.advanceTimersByTime(4000)
        expect(onExpired).toHaveBeenCalledOnce()

        tracker.dispose()
    })
})
