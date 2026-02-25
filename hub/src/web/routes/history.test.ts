import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SentMessageEntry } from '@hapi/protocol/types'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createHistoryRoutes } from './history'

const STUB_ENTRIES: SentMessageEntry[] = [
    { text: 'fix the auth bug', lastUsedAt: 1700000003, useCount: 3, lastSessionId: 's1', lastSessionName: 'Auth' },
    { text: 'add dark mode', lastUsedAt: 1700000002, useCount: 1, lastSessionId: 's2', lastSessionName: 'UI' },
    { text: 'refactor database', lastUsedAt: 1700000001, useCount: 2, lastSessionId: 's3' }
]

function createTestApp(entries: SentMessageEntry[] = STUB_ENTRIES): Hono<WebAppEnv> {
    const engine = {
        getSentMessages: (_namespace: string, limit?: number) => {
            const effectiveLimit = limit ?? 200
            return entries.slice(0, effectiveLimit)
        }
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createHistoryRoutes(() => engine))
    return app
}

describe('GET /api/messages/sent', () => {
    it('returns messages array with correct shape', async () => {
        const app = createTestApp()
        const res = await app.request('http://localhost/api/messages/sent')

        expect(res.status).toBe(200)
        const body = (await res.json()) as { messages: SentMessageEntry[] }
        expect(body.messages).toHaveLength(3)

        const first = body.messages[0]
        expect(first.text).toBe('fix the auth bug')
        expect(first.lastUsedAt).toBe(1700000003)
        expect(first.useCount).toBe(3)
        expect(first.lastSessionId).toBe('s1')
        expect(first.lastSessionName).toBe('Auth')
    })

    it('uses default limit of 200 when no query param', async () => {
        let capturedLimit: number | undefined
        const engine = {
            getSentMessages: (_ns: string, limit?: number) => {
                capturedLimit = limit
                return []
            }
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('userId', 1)
            await next()
        })
        app.route('/api', createHistoryRoutes(() => engine))

        await app.request('http://localhost/api/messages/sent')
        expect(capturedLimit).toBe(200)
    })

    it('passes custom limit query parameter to engine', async () => {
        let capturedLimit: number | undefined
        const engine = {
            getSentMessages: (_ns: string, limit?: number) => {
                capturedLimit = limit
                return []
            }
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('userId', 1)
            await next()
        })
        app.route('/api', createHistoryRoutes(() => engine))

        await app.request('http://localhost/api/messages/sent?limit=50')
        expect(capturedLimit).toBe(50)
    })

    it('falls back to default limit when limit < 1', async () => {
        let capturedLimit: number | undefined
        const engine = {
            getSentMessages: (_ns: string, limit?: number) => {
                capturedLimit = limit
                return []
            }
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('userId', 1)
            await next()
        })
        app.route('/api', createHistoryRoutes(() => engine))

        // limit=0 fails z.coerce.number().int().min(1) validation → fallback to 200
        await app.request('http://localhost/api/messages/sent?limit=0')
        expect(capturedLimit).toBe(200)
    })

    it('falls back to default limit when limit > 200', async () => {
        let capturedLimit: number | undefined
        const engine = {
            getSentMessages: (_ns: string, limit?: number) => {
                capturedLimit = limit
                return []
            }
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('userId', 1)
            await next()
        })
        app.route('/api', createHistoryRoutes(() => engine))

        // limit=999 fails z.coerce.number().int().max(200) validation → fallback to 200
        await app.request('http://localhost/api/messages/sent?limit=999')
        expect(capturedLimit).toBe(200)
    })

    it('returns empty messages array when no history exists', async () => {
        const app = createTestApp([])
        const res = await app.request('http://localhost/api/messages/sent')

        expect(res.status).toBe(200)
        const body = (await res.json()) as { messages: SentMessageEntry[] }
        expect(body.messages).toHaveLength(0)
    })

    it('returns 503 when sync engine is unavailable', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('userId', 1)
            await next()
        })
        app.route('/api', createHistoryRoutes(() => null))

        const res = await app.request('http://localhost/api/messages/sent')
        expect(res.status).toBe(503)
    })
})
