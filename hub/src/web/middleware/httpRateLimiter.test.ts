import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Hono } from 'hono'
import { createHttpRateLimiter } from './httpRateLimiter'

/** Minimal app wired with one or more rate-limit middlewares + echo handler */
function createTestApp(
    limiters: Array<{ path: string; windowMs?: number; baseLimit?: number }>
): Hono {
    const app = new Hono()
    for (const l of limiters) {
        app.use('*', createHttpRateLimiter(l.path, { windowMs: l.windowMs, baseLimit: l.baseLimit }))
    }
    // Catch-all handler returns 200 with the matched path
    app.all('*', (c) => c.json({ ok: true, path: c.req.path }))
    return app
}

function req(app: Hono, path: string, method = 'POST') {
    return app.request(`http://localhost${path}`, { method })
}

describe('createHttpRateLimiter', () => {
    afterEach(() => {
        setSystemTime() // restore real time
    })

    it('allows requests within the window limit', async () => {
        const app = createTestApp([{ path: '/api/auth', baseLimit: 3, windowMs: 60_000 }])

        for (let i = 0; i < 3; i++) {
            const res = await req(app, '/api/auth')
            expect(res.status).toBe(200)
        }
    })

    it('returns 429 with Retry-After header when limit exceeded', async () => {
        const app = createTestApp([{ path: '/api/auth', baseLimit: 2, windowMs: 30_000 }])

        await req(app, '/api/auth')
        await req(app, '/api/auth')

        const res = await req(app, '/api/auth')
        expect(res.status).toBe(429)

        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Too many requests')
        expect(res.headers.get('Retry-After')).toBe('30')
    })

    it('/auth and /bind have independent quotas', async () => {
        const app = createTestApp([
            { path: '/api/auth', baseLimit: 2, windowMs: 60_000 },
            { path: '/api/bind', baseLimit: 2, windowMs: 60_000 },
        ])

        // Exhaust /api/auth quota
        await req(app, '/api/auth')
        await req(app, '/api/auth')
        const authBlocked = await req(app, '/api/auth')
        expect(authBlocked.status).toBe(429)

        // /api/bind should still be available
        const bindOk = await req(app, '/api/bind')
        expect(bindOk.status).toBe(200)
    })

    it('resets after window expires', async () => {
        const baseTime = Date.now()
        setSystemTime(new Date(baseTime))

        const windowMs = 1_000
        const app = createTestApp([{ path: '/api/auth', baseLimit: 2, windowMs }])

        await req(app, '/api/auth')
        await req(app, '/api/auth')
        const blocked = await req(app, '/api/auth')
        expect(blocked.status).toBe(429)

        // Advance past window
        setSystemTime(new Date(baseTime + windowMs + 100))

        const allowed = await req(app, '/api/auth')
        expect(allowed.status).toBe(200)
    })

    it('exact path matching: /api/auth/refresh not caught by /api/auth limiter', async () => {
        const app = createTestApp([{ path: '/api/auth', baseLimit: 1, windowMs: 60_000 }])

        // Exhaust /api/auth quota
        await req(app, '/api/auth')
        const authBlocked = await req(app, '/api/auth')
        expect(authBlocked.status).toBe(429)

        // /api/auth/refresh must pass through unaffected
        const refreshOk = await req(app, '/api/auth/refresh')
        expect(refreshOk.status).toBe(200)
    })

    it('OPTIONS requests are not counted toward the quota', async () => {
        const app = createTestApp([{ path: '/api/auth', baseLimit: 2, windowMs: 60_000 }])

        // Send OPTIONS — should not consume quota
        const options1 = await req(app, '/api/auth', 'OPTIONS')
        expect(options1.status).toBe(200)
        const options2 = await req(app, '/api/auth', 'OPTIONS')
        expect(options2.status).toBe(200)

        // Both real requests should still be allowed
        const post1 = await req(app, '/api/auth')
        expect(post1.status).toBe(200)
        const post2 = await req(app, '/api/auth')
        expect(post2.status).toBe(200)

        // Now the limit is hit
        const post3 = await req(app, '/api/auth')
        expect(post3.status).toBe(429)
    })
})
