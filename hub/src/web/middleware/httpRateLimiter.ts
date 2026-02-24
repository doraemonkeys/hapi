import type { MiddlewareHandler } from 'hono'
import { RateLimiter } from '../../socket/rateLimiter'

/**
 * Global HTTP rate limiter for public endpoints.
 *
 * Uses exact path matching so `/api/auth` does not intercept
 * `/api/auth/refresh`. OPTIONS (CORS preflight) requests are
 * excluded from the quota to avoid spurious 429s in cross-origin
 * scenarios.
 *
 * One RateLimiter instance per call — each protected path gets
 * its own independent quota.
 */
export function createHttpRateLimiter(
    exactPath: string,
    options?: { windowMs?: number; baseLimit?: number }
): MiddlewareHandler {
    const windowMs = options?.windowMs ?? 60_000
    const baseLimit = options?.baseLimit ?? 60

    const limiter = new RateLimiter({ windowMs, baseLimit })
    const key = `__global__${exactPath}`

    return async (c, next) => {
        // Exact path match: /api/auth must not intercept /api/auth/refresh
        if (c.req.path !== exactPath) return next()
        // CORS preflight bypass
        if (c.req.method === 'OPTIONS') return next()

        const result = limiter.check(key)
        if (!result.allowed) {
            c.header('Retry-After', String(Math.ceil(windowMs / 1000)))
            return c.json({ error: 'Too many requests' }, 429)
        }
        return next()
    }
}
