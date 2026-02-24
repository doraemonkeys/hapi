import { describe, expect, it, mock } from 'bun:test'
import { jwtVerify } from 'jose'

const TEST_CLI_TOKEN = 'test-cli-api-token-123'

// Mock configuration and getOrCreateOwnerId before importing auth route
mock.module('../../configuration', () => ({
    configuration: {
        cliApiToken: TEST_CLI_TOKEN,
        telegramEnabled: false,
        telegramBotToken: null
    }
}))
mock.module('../../config/ownerId', () => ({
    getOrCreateOwnerId: async () => 1
}))

// Dynamic import after mocks are in place
const { Hono } = await import('hono')
const { createAuthRoutes } = await import('./auth')
const { Store } = await import('../../store')

const SECRET = new TextEncoder().encode('test-secret-key-for-jwt-testing!')

function createTestApp() {
    const store = new Store(':memory:')
    const app = new Hono()
    app.route('/api', createAuthRoutes(SECRET, store))
    return app
}

describe('POST /api/auth — session_iat claim', () => {
    it('signed token contains session_iat equal to signing time', async () => {
        const app = createTestApp()
        const beforeSeconds = Math.floor(Date.now() / 1000)

        const res = await app.request('http://localhost/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: TEST_CLI_TOKEN })
        })
        expect(res.status).toBe(200)

        const afterSeconds = Math.floor(Date.now() / 1000)
        const body = (await res.json()) as { token: string }
        const { payload } = await jwtVerify(body.token, SECRET)

        expect(typeof payload.session_iat).toBe('number')
        const sessionIat = payload.session_iat as number
        // session_iat should be within the test window
        expect(sessionIat).toBeGreaterThanOrEqual(beforeSeconds)
        expect(sessionIat).toBeLessThanOrEqual(afterSeconds)
    })
})
