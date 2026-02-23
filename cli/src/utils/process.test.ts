import { describe, expect, it, vi } from 'vitest'
import { isProcessAlive, getDescendantCount, getProcessMemory, isWindows } from './process'

describe('isProcessAlive', () => {
    it('returns true for the current process PID', () => {
        expect(isProcessAlive(process.pid)).toBe(true)
    })

    it('returns false for an invalid PID (0)', () => {
        expect(isProcessAlive(0)).toBe(false)
    })

    it('returns false for negative PID', () => {
        expect(isProcessAlive(-1)).toBe(false)
    })

    it('returns false for NaN', () => {
        expect(isProcessAlive(NaN)).toBe(false)
    })

    it('returns false for Infinity', () => {
        expect(isProcessAlive(Infinity)).toBe(false)
    })

    it('returns false for a very large non-existent PID', () => {
        // PID 9999999 is extremely unlikely to exist
        expect(isProcessAlive(9999999)).toBe(false)
    })
})

describe('getDescendantCount', () => {
    it('returns 0 for invalid PID (0)', () => {
        expect(getDescendantCount(0)).toBe(0)
    })

    it('returns 0 for negative PID', () => {
        expect(getDescendantCount(-1)).toBe(0)
    })

    it('returns 0 for NaN', () => {
        expect(getDescendantCount(NaN)).toBe(0)
    })

    it('returns 0 for a non-existent PID', () => {
        expect(getDescendantCount(9999999)).toBe(0)
    })

    it('returns a non-negative integer for the current process', () => {
        const count = getDescendantCount(process.pid)
        expect(typeof count).toBe('number')
        expect(count).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(count)).toBe(true)
    })
})

describe('getProcessMemory', () => {
    describe('single PID overload', () => {
        it('returns a positive number for the current process', () => {
            const mem = getProcessMemory(process.pid)
            // On some CI environments this might return null, but locally it should work
            if (mem !== null) {
                expect(typeof mem).toBe('number')
                expect(mem).toBeGreaterThan(0)
            }
        })

        it('returns null for a non-existent PID', () => {
            const mem = getProcessMemory(9999999)
            expect(mem).toBeNull()
        })
    })

    describe('batch PID overload', () => {
        it('returns a Map for an array of PIDs', () => {
            const result = getProcessMemory([process.pid, 9999999])
            expect(result).toBeInstanceOf(Map)
            expect(result.has(process.pid)).toBe(true)
            expect(result.has(9999999)).toBe(true)
            // Non-existent PID should be null
            expect(result.get(9999999)).toBeNull()
        })

        it('returns an empty Map for empty input array', () => {
            const result = getProcessMemory([])
            expect(result).toBeInstanceOf(Map)
            expect(result.size).toBe(0)
        })
    })
})

describe('isWindows', () => {
    it('returns a boolean', () => {
        expect(typeof isWindows()).toBe('boolean')
    })

    it('matches process.platform check', () => {
        expect(isWindows()).toBe(process.platform === 'win32')
    })
})
