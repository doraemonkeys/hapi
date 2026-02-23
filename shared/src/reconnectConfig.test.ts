import { describe, expect, it } from 'bun:test'
import {
    RECONNECT_ENABLED,
    RECONNECT_ATTEMPTS,
    RECONNECT_DELAY_MS,
    RECONNECT_DELAY_MAX_MS,
    RECONNECT_RANDOMIZATION_FACTOR,
    RECONNECT_ESCALATION_THRESHOLDS,
    SSE_RECONNECT_DELAY_MS,
    SSE_RECONNECT_DELAY_MAX_MS,
    SSE_RECONNECT_RANDOMIZATION_FACTOR,
    RECONNECT_LOG_THRESHOLDS,
    RECONNECT_SUMMARY_INTERVAL,
} from './reconnectConfig'

describe('reconnectConfig exports', () => {
    it('exports socket.io baseline constants with correct types', () => {
        expect(RECONNECT_ENABLED).toBe(true)
        expect(RECONNECT_ATTEMPTS).toBe(Infinity)
        expect(typeof RECONNECT_DELAY_MS).toBe('number')
        expect(typeof RECONNECT_DELAY_MAX_MS).toBe('number')
        expect(typeof RECONNECT_RANDOMIZATION_FACTOR).toBe('number')
    })

    it('baseline delay is less than baseline max delay', () => {
        expect(RECONNECT_DELAY_MS).toBeLessThan(RECONNECT_DELAY_MAX_MS)
    })

    it('randomization factor is within valid range (0, 1]', () => {
        expect(RECONNECT_RANDOMIZATION_FACTOR).toBeGreaterThan(0)
        expect(RECONNECT_RANDOMIZATION_FACTOR).toBeLessThanOrEqual(1)
    })

    it('exports progressive escalation thresholds in ascending order', () => {
        const thresholdKeys = Object.keys(RECONNECT_ESCALATION_THRESHOLDS)
            .map(Number)
            .sort((a, b) => a - b)

        expect(thresholdKeys.length).toBeGreaterThan(0)

        // Each successive threshold should have a larger (or equal) delay max
        let prevDelay = 0
        for (const key of thresholdKeys) {
            const delay = RECONNECT_ESCALATION_THRESHOLDS[key]!
            expect(delay).toBeGreaterThanOrEqual(prevDelay)
            prevDelay = delay
        }
    })

    it('escalation delay maxes all exceed the baseline delay max', () => {
        for (const delayMax of Object.values(RECONNECT_ESCALATION_THRESHOLDS)) {
            expect(delayMax).toBeGreaterThan(RECONNECT_DELAY_MAX_MS)
        }
    })

    it('exports SSE reconnect constants with correct types', () => {
        expect(typeof SSE_RECONNECT_DELAY_MS).toBe('number')
        expect(typeof SSE_RECONNECT_DELAY_MAX_MS).toBe('number')
        expect(typeof SSE_RECONNECT_RANDOMIZATION_FACTOR).toBe('number')
        expect(SSE_RECONNECT_DELAY_MS).toBeLessThan(SSE_RECONNECT_DELAY_MAX_MS)
    })

    it('SSE randomization factor is within valid range (0, 1]', () => {
        expect(SSE_RECONNECT_RANDOMIZATION_FACTOR).toBeGreaterThan(0)
        expect(SSE_RECONNECT_RANDOMIZATION_FACTOR).toBeLessThanOrEqual(1)
    })

    it('exports telemetry thresholds in ascending order', () => {
        for (let i = 1; i < RECONNECT_LOG_THRESHOLDS.length; i++) {
            expect(RECONNECT_LOG_THRESHOLDS[i]).toBeGreaterThan(RECONNECT_LOG_THRESHOLDS[i - 1]!)
        }
    })

    it('summary interval is a positive integer', () => {
        expect(RECONNECT_SUMMARY_INTERVAL).toBeGreaterThan(0)
        expect(Number.isInteger(RECONNECT_SUMMARY_INTERVAL)).toBe(true)
    })
})
