import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'
import { RateLimiter } from './rateLimiter'

describe('RateLimiter', () => {
    let limiter: RateLimiter

    afterEach(() => {
        limiter?.destroy()
    })

    describe('basic sliding window', () => {
        it('allows operations under the limit', () => {
            limiter = new RateLimiter({ baseLimit: 5, windowMs: 60_000 })

            for (let i = 0; i < 5; i++) {
                const result = limiter.check('key1')
                expect(result.allowed).toBe(true)
                expect(result.count).toBe(i + 1)
                expect(result.limit).toBe(5)
            }
        })

        it('rejects operations over the limit', () => {
            limiter = new RateLimiter({ baseLimit: 3, windowMs: 60_000 })

            limiter.check('key1')
            limiter.check('key1')
            limiter.check('key1')

            const result = limiter.check('key1')
            expect(result.allowed).toBe(false)
            expect(result.count).toBe(3)
            expect(result.limit).toBe(3)
        })

        it('returns correct count when rejected', () => {
            limiter = new RateLimiter({ baseLimit: 2, windowMs: 60_000 })

            limiter.check('key1')
            limiter.check('key1')

            const result = limiter.check('key1')
            expect(result.allowed).toBe(false)
            expect(result.count).toBe(2) // existing count, not incremented
        })
    })

    describe('per-key isolation', () => {
        it('tracks keys independently', () => {
            limiter = new RateLimiter({ baseLimit: 2, windowMs: 60_000 })

            limiter.check('machine-a')
            limiter.check('machine-a')
            const aResult = limiter.check('machine-a')
            expect(aResult.allowed).toBe(false)

            // Different key should still be allowed
            const bResult = limiter.check('machine-b')
            expect(bResult.allowed).toBe(true)
            expect(bResult.count).toBe(1)
        })
    })

    describe('window expiry', () => {
        it('allows operations again after window expires', () => {
            const windowMs = 1_000
            limiter = new RateLimiter({ baseLimit: 2, windowMs })

            const baseTime = Date.now()
            setSystemTime(new Date(baseTime))

            limiter.check('key1')
            limiter.check('key1')

            const rejected = limiter.check('key1')
            expect(rejected.allowed).toBe(false)

            // Advance past window
            setSystemTime(new Date(baseTime + windowMs + 100))

            const allowed = limiter.check('key1')
            expect(allowed.allowed).toBe(true)
            expect(allowed.count).toBe(1)

            setSystemTime() // reset to real time
        })
    })

    describe('adaptive scaling with session count', () => {
        it('scales limit proportionally to session count', () => {
            limiter = new RateLimiter({
                baseLimit: 5,
                sessionScaleFactor: 2,
                windowMs: 60_000,
            })

            // With 0 sessions: limit = 5 + 2*0 = 5
            expect(limiter.effectiveLimit(0)).toBe(5)

            // With 3 sessions: limit = 5 + 2*3 = 11
            expect(limiter.effectiveLimit(3)).toBe(11)

            // With 10 sessions: limit = 5 + 2*10 = 25
            expect(limiter.effectiveLimit(10)).toBe(25)
        })

        it('uses base limit when session count is undefined', () => {
            limiter = new RateLimiter({
                baseLimit: 10,
                sessionScaleFactor: 3,
            })

            expect(limiter.effectiveLimit(undefined)).toBe(10)
            expect(limiter.effectiveLimit()).toBe(10)
        })

        it('uses base limit when session count is negative', () => {
            limiter = new RateLimiter({ baseLimit: 10, sessionScaleFactor: 3 })
            expect(limiter.effectiveLimit(-5)).toBe(10)
        })

        it('check uses adaptive limit when session count is provided', () => {
            limiter = new RateLimiter({
                baseLimit: 2,
                sessionScaleFactor: 2,
                windowMs: 60_000,
            })

            // Without sessions: limit = 2
            limiter.check('key1')
            limiter.check('key1')
            const rejected = limiter.check('key1')
            expect(rejected.allowed).toBe(false)

            // With 1 session: limit = 2 + 2*1 = 4
            const allowed = limiter.check('key1', 1)
            expect(allowed.allowed).toBe(true)
            expect(allowed.limit).toBe(4)
        })
    })

    describe('peek', () => {
        it('returns current count without recording', () => {
            limiter = new RateLimiter({ baseLimit: 5, windowMs: 60_000 })

            expect(limiter.peek('key1')).toBe(0)

            limiter.check('key1')
            limiter.check('key1')

            expect(limiter.peek('key1')).toBe(2)

            // Peek should not change the count
            expect(limiter.peek('key1')).toBe(2)
        })

        it('returns 0 for unknown keys', () => {
            limiter = new RateLimiter({ baseLimit: 5, windowMs: 60_000 })
            expect(limiter.peek('nonexistent')).toBe(0)
        })
    })

    describe('cleanup', () => {
        it('removes expired entries from all keys', () => {
            const windowMs = 1_000
            limiter = new RateLimiter({ baseLimit: 10, windowMs })

            const baseTime = Date.now()
            setSystemTime(new Date(baseTime))

            limiter.check('key1')
            limiter.check('key2')

            // Advance past window
            setSystemTime(new Date(baseTime + windowMs + 100))
            limiter.cleanup()

            // Both keys should have been cleaned up; peek returns 0
            expect(limiter.peek('key1')).toBe(0)
            expect(limiter.peek('key2')).toBe(0)

            setSystemTime()
        })

        it('retains entries within the window', () => {
            const windowMs = 60_000
            limiter = new RateLimiter({ baseLimit: 10, windowMs })

            limiter.check('key1')
            limiter.check('key1')
            limiter.cleanup()

            expect(limiter.peek('key1')).toBe(2)
        })
    })

    describe('defaults', () => {
        it('uses sensible defaults when no options provided', () => {
            limiter = new RateLimiter()

            // Should use default base limit (20)
            const result = limiter.check('key1')
            expect(result.allowed).toBe(true)
            expect(result.limit).toBe(20)
        })
    })

    describe('destroy', () => {
        it('cleans up the interval timer', () => {
            limiter = new RateLimiter()
            // Should not throw
            limiter.destroy()
            limiter.destroy() // idempotent
        })
    })
})
