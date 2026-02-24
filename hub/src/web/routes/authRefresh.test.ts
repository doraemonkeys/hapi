import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createAuthRefreshRoutes } from './authRefresh'

const SECRET = new TextEncoder().encode('test-secret-key-for-jwt-testing!')

/** Sign a JWT with configurable claims */
async function signToken(claims: Record<string, unknown>, expiresIn = '15m'): Promise<string> {
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(SECRET)
}

function createTestApp(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(SECRET))
    app.route('/api', createAuthRefreshRoutes(SECRET))
    return app
}

function refreshReq(app: Hono<WebAppEnv>, token: string) {
    return app.request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
    })
}

describe('POST /api/auth/refresh', () => {
    afterEach(() => {
        setSystemTime()
    })

    it('returns a new token preserving session_iat', async () => {
        const app = createTestApp()
        const sessionIat = Math.floor(Date.now() / 1000) - 60
        const token = await signToken({ uid: 1, ns: 'default', session_iat: sessionIat })

        const res = await refreshReq(app, token)
        expect(res.status).toBe(200)

        const body = (await res.json()) as { token: string }
        expect(body.token).toBeDefined()

        // Verify the new token preserves session_iat
        const { payload } = await jwtVerify(body.token, SECRET)
        expect(payload.uid).toBe(1)
        expect(payload.ns).toBe('default')
        expect(payload.session_iat).toBe(sessionIat)
    })

    it('rejects refresh when session_iat exceeds 7-day absolute lifetime', async () => {
        const now = Math.floor(Date.now() / 1000)
        const eightDaysAgo = now - 8 * 24 * 60 * 60
        const app = createTestApp()
        const token = await signToken({ uid: 1, ns: 'default', session_iat: eightDaysAgo })

        const res = await refreshReq(app, token)
        expect(res.status).toBe(401)

        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Session expired, re-authentication required')
    })

    it('allows renewal for legacy tokens without session_iat (backward compat)', async () => {
        const app = createTestApp()
        const token = await signToken({ uid: 42, ns: 'legacy-ns' })

        const res = await refreshReq(app, token)
        expect(res.status).toBe(200)

        const body = (await res.json()) as { token: string }
        const { payload } = await jwtVerify(body.token, SECRET)
        expect(payload.uid).toBe(42)
        expect(payload.ns).toBe('legacy-ns')
        // Legacy token gets session_iat assigned as current time
        expect(typeof payload.session_iat).toBe('number')
    })

    it('rejects requests without Authorization header', async () => {
        const app = createTestApp()

        const res = await app.request('http://localhost/api/auth/refresh', {
            method: 'POST'
        })
        expect(res.status).toBe(401)
    })
})
