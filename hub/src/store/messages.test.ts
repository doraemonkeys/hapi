import { describe, expect, it } from 'bun:test'
import { Store } from './index'

// Helper: creates a user-sent message envelope matching the content shape
// expected by getUserSentMessages (role=user, content.type=text).
function userMessage(text: string) {
    return { role: 'user', content: { type: 'text', text } }
}

// Helper: creates an assistant message (should be excluded by the query).
function assistantMessage(text: string) {
    return { role: 'assistant', content: { type: 'text', text } }
}

describe('getUserSentMessages', () => {
    it('returns deduplicated messages ordered by most recent first', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/repo', name: 'My Session' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('fix the bug'))
        await Bun.sleep(2)
        store.messages.addMessage(session.id, userMessage('add tests'))
        await Bun.sleep(2)
        // Re-send "fix the bug" — now has the most recent created_at
        store.messages.addMessage(session.id, userMessage('fix the bug'))

        const rows = store.messages.getUserSentMessages('ns')
        const texts = rows.map((r) => r.text)

        // Most recently used first
        expect(texts[0]).toBe('fix the bug')
        expect(texts[1]).toBe('add tests')
        expect(rows).toHaveLength(2)
    })

    it('aggregates use_count across duplicate texts', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('deploy'))
        store.messages.addMessage(session.id, userMessage('deploy'))
        store.messages.addMessage(session.id, userMessage('deploy'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].use_count).toBe(3)
    })

    it('deduplicates messages differing only by leading/trailing whitespace (TRIM)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('  hello world  '))
        store.messages.addMessage(session.id, userMessage('hello world'))
        store.messages.addMessage(session.id, userMessage('hello world  '))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].text).toBe('hello world')
        expect(rows[0].use_count).toBe(3)
    })

    it('picks last_session_id from the most recent occurrence', async () => {
        const store = new Store(':memory:')
        const sessionA = store.sessions.getOrCreateSession('a', { path: '/a', name: 'Session A' }, null, 'ns')
        const sessionB = store.sessions.getOrCreateSession('b', { path: '/b', name: 'Session B' }, null, 'ns')

        store.messages.addMessage(sessionA.id, userMessage('shared prompt'))
        await Bun.sleep(2)
        store.messages.addMessage(sessionB.id, userMessage('shared prompt'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].last_session_id).toBe(sessionB.id)
    })

    it('resolves last_session_name from session metadata', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p', name: 'Cool Project' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('run tests'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].last_session_name).toBe('Cool Project')
    })

    it('returns null last_session_name when session metadata has no name', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('run tests'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].last_session_name).toBeNull()
    })

    it('respects the limit parameter', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        for (let i = 0; i < 10; i++) {
            store.messages.addMessage(session.id, userMessage(`message ${i}`))
        }

        const rows = store.messages.getUserSentMessages('ns', 3)
        expect(rows).toHaveLength(3)
    })

    it('filters out messages with LENGTH < 3 after trim', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        store.messages.addMessage(session.id, userMessage('ab'))
        store.messages.addMessage(session.id, userMessage('  x '))
        store.messages.addMessage(session.id, userMessage('abc'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].text).toBe('abc')
    })

    it('scopes results by namespace — messages from other namespaces are excluded', () => {
        const store = new Store(':memory:')
        const sessionNsA = store.sessions.getOrCreateSession('a', { path: '/a' }, null, 'ns-a')
        const sessionNsB = store.sessions.getOrCreateSession('b', { path: '/b' }, null, 'ns-b')

        store.messages.addMessage(sessionNsA.id, userMessage('prompt A'))
        store.messages.addMessage(sessionNsB.id, userMessage('prompt B'))

        const rowsA = store.messages.getUserSentMessages('ns-a')
        expect(rowsA).toHaveLength(1)
        expect(rowsA[0].text).toBe('prompt A')

        const rowsB = store.messages.getUserSentMessages('ns-b')
        expect(rowsB).toHaveLength(1)
        expect(rowsB[0].text).toBe('prompt B')
    })

    it('excludes assistant messages', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        store.messages.addMessage(session.id, assistantMessage('I can help'))
        store.messages.addMessage(session.id, userMessage('do something'))

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(1)
        expect(rows[0].text).toBe('do something')
    })

    it('returns empty array when no messages match', () => {
        const store = new Store(':memory:')
        store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        const rows = store.messages.getUserSentMessages('ns')
        expect(rows).toHaveLength(0)
    })

    it('clamps limit to valid range', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('tag', { path: '/p' }, null, 'ns')

        for (let i = 0; i < 5; i++) {
            store.messages.addMessage(session.id, userMessage(`msg ${i}`))
        }

        // limit < 1 → clamped to 1
        const rowsMin = store.messages.getUserSentMessages('ns', 0)
        expect(rowsMin).toHaveLength(1)

        // limit > 200 → clamped to 200 (effectively returns all 5)
        const rowsMax = store.messages.getUserSentMessages('ns', 999)
        expect(rowsMax).toHaveLength(5)
    })
})

describe('copyMessagesUpTo', () => {
    it('copies source history and shifts existing target messages', () => {
        const store = new Store(':memory:')
        const source = store.sessions.getOrCreateSession('source', { path: '/source' }, null, 'default')
        const target = store.sessions.getOrCreateSession('target', { path: '/target' }, null, 'default')

        const sourceOne = store.messages.addMessage(source.id, { text: 'source-1' }, 'source-local-1')
        const sourceTwo = store.messages.addMessage(source.id, { text: 'source-2' }, 'source-local-2')
        store.messages.addMessage(source.id, { text: 'source-3' }, 'source-local-3')

        store.messages.addMessage(target.id, { text: 'target-1' }, 'target-local-1')
        store.messages.addMessage(target.id, { text: 'target-2' }, 'target-local-2')

        const copied = store.messages.copyMessagesUpTo(source.id, target.id, 2)
        expect(copied).toBe(2)

        const targetMessages = store.messages.getMessages(target.id, 20)
        expect(targetMessages.map((message) => message.seq)).toEqual([1, 2, 3, 4])
        expect(targetMessages.map((message) => message.content)).toEqual([
            { text: 'source-1' },
            { text: 'source-2' },
            { text: 'target-1' },
            { text: 'target-2' }
        ])
        expect(targetMessages[0]?.createdAt).toBe(sourceOne.createdAt)
        expect(targetMessages[1]?.createdAt).toBe(sourceTwo.createdAt)
        expect(targetMessages[0]?.localId).toBeNull()
        expect(targetMessages[1]?.localId).toBeNull()
        expect(targetMessages[2]?.localId).toBe('target-local-1')
        expect(targetMessages[3]?.localId).toBe('target-local-2')

        const sourceMessages = store.messages.getMessages(source.id, 20)
        expect(sourceMessages.map((message) => message.seq)).toEqual([1, 2, 3])
        expect(sourceMessages.map((message) => message.content)).toEqual([
            { text: 'source-1' },
            { text: 'source-2' },
            { text: 'source-3' }
        ])
    })

    it('returns zero when no copy is needed', () => {
        const store = new Store(':memory:')
        const source = store.sessions.getOrCreateSession('source', { path: '/source' }, null, 'default')
        const target = store.sessions.getOrCreateSession('target', { path: '/target' }, null, 'default')
        store.messages.addMessage(source.id, { text: 'source-1' })
        store.messages.addMessage(target.id, { text: 'target-1' })

        expect(store.messages.copyMessagesUpTo(source.id, target.id, 0)).toBe(0)
        expect(store.messages.copyMessagesUpTo(source.id, source.id, 1)).toBe(0)

        const targetMessages = store.messages.getMessages(target.id, 20)
        expect(targetMessages.map((message) => message.seq)).toEqual([1])
        expect(targetMessages[0]?.content).toEqual({ text: 'target-1' })
    })
})

describe('getMessages thread scope', () => {
    it('returns cross-thread history when threadId is omitted', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('session', { path: '/repo' }, null, 'default')

        store.messages.addMessage(session.id, { text: 'old-main' }, undefined, 'thread-old-main')
        store.messages.addMessage(session.id, { text: 'new-main' }, undefined, 'thread-new-main')
        store.messages.addMessage(session.id, { text: 'sub-agent' }, undefined, 'thread-sub')
        store.messages.addMessage(session.id, { text: 'unscoped' })

        const allMessages = store.messages.getMessages(session.id, 20)
        expect(allMessages.map((message) => message.content)).toEqual([
            { text: 'old-main' },
            { text: 'new-main' },
            { text: 'sub-agent' },
            { text: 'unscoped' }
        ])
    })

    it('applies threadId filter only when explicitly requested', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('session', { path: '/repo' }, null, 'default')

        store.messages.addMessage(session.id, { text: 'old-main' }, undefined, 'thread-old-main')
        store.messages.addMessage(session.id, { text: 'new-main' }, undefined, 'thread-new-main')
        store.messages.addMessage(session.id, { text: 'sub-agent' }, undefined, 'thread-sub')
        store.messages.addMessage(session.id, { text: 'unscoped' })

        const filtered = store.messages.getMessages(session.id, 20, undefined, 'thread-new-main')
        expect(filtered.map((message) => message.content)).toEqual([
            { text: 'new-main' },
            { text: 'unscoped' }
        ])
    })
})
