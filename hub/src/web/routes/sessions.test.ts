import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine, ForkSessionResult } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createTestApp(forkResult: ForkSessionResult): Hono<WebAppEnv> {
    const engine = {
        forkSession: async () => forkResult
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))
    return app
}

describe('sessions fork route', () => {
    it('returns 404 when fork target message is missing', async () => {
        const app = createTestApp({
            type: 'error',
            message: 'Fork target message not found',
            code: 'fork_target_not_found'
        })

        const response = await app.request('http://localhost/api/sessions/source/fork', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageSeq: 999 })
        })

        expect(response.status).toBe(404)
    })
})
