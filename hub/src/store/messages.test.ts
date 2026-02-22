import { describe, expect, it } from 'bun:test'
import { Store } from './index'

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
