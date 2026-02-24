import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'

/** Absolute session lifetime: 7 days from initial authentication */
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export function createAuthRefreshRoutes(jwtSecret: Uint8Array): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth/refresh', async (c) => {
        const userId = c.get('userId')
        const namespace = c.get('namespace')
        const sessionIat = c.get('sessionIat')

        // Reject renewal when the absolute session lifetime (7 days) is exceeded
        if (sessionIat !== undefined && Date.now() / 1000 - sessionIat > SESSION_MAX_AGE_SECONDS) {
            return c.json({ error: 'Session expired, re-authentication required' }, 401)
        }

        // Preserve original session_iat so the absolute lifetime clock is never reset.
        // For legacy tokens without session_iat, omit the claim; next full auth will set it.
        const now = Math.floor(Date.now() / 1000)
        const newToken = await new SignJWT({
            uid: userId,
            ns: namespace,
            session_iat: sessionIat ?? now
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('15m')
            .sign(jwtSecret)

        return c.json({ token: newToken })
    })

    return app
}
