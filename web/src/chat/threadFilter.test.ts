import { describe, expect, it } from 'vitest'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { filterBlocksByMainThread, filterMainThreadBlocks } from '@/chat/threadFilter'
import type { ThreadRegistry } from '@/chat/threadRegistry'

function createRegistry(overrides?: Partial<ThreadRegistry>): ThreadRegistry {
    return {
        mainThreadId: null,
        mainThreadSignal: null,
        subAgentThreadIds: new Set<string>(),
        spawnCallIdToThreadId: new Map<string, string>(),
        ...overrides
    }
}

describe('filterBlocksByMainThread', () => {
    it('returns all blocks when main thread is unknown', () => {
        const blocks: ChatBlock[] = [{
            kind: 'agent-text',
            id: 'b1',
            localId: null,
            createdAt: 1,
            text: 'hello',
            threadId: 'thread-sub'
        }]

        const filtered = filterBlocksByMainThread(blocks, createRegistry())
        expect(filtered).toBe(blocks)
    })

    it('keeps main-thread and unscoped blocks while dropping sub-agent blocks across block kinds', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-main',
                localId: null,
                createdAt: 1,
                text: 'main user',
                threadId: 'thread-main'
            },
            {
                kind: 'agent-text',
                id: 'agent-no-thread',
                localId: null,
                createdAt: 2,
                text: 'no thread id'
            },
            {
                kind: 'agent-reasoning',
                id: 'reason-sub',
                localId: null,
                createdAt: 3,
                text: 'sub reasoning',
                threadId: 'thread-sub'
            },
            {
                kind: 'agent-event',
                id: 'event-sub',
                createdAt: 4,
                event: { type: 'message', message: 'sub event' },
                threadId: 'thread-sub'
            },
            {
                kind: 'tool-call',
                id: 'tool-main',
                localId: null,
                createdAt: 5,
                threadId: 'thread-main',
                tool: {
                    id: 'tool-main',
                    name: 'CodexBash',
                    state: 'completed',
                    input: { command: 'pwd' },
                    createdAt: 5,
                    startedAt: 5,
                    completedAt: 6,
                    description: null,
                    threadId: 'thread-main'
                },
                children: []
            },
            {
                kind: 'tool-call',
                id: 'tool-sub',
                localId: null,
                createdAt: 6,
                threadId: 'thread-unknown-sub',
                tool: {
                    id: 'tool-sub',
                    name: 'CodexBash',
                    state: 'completed',
                    input: { command: 'pwd' },
                    createdAt: 6,
                    startedAt: 6,
                    completedAt: 7,
                    description: null,
                    threadId: 'thread-unknown-sub'
                },
                children: []
            }
        ]

        const filtered = filterBlocksByMainThread(blocks, createRegistry({
            mainThreadId: 'thread-main',
            subAgentThreadIds: new Set(['thread-sub'])
        }))

        expect(filtered.map((block) => block.id)).toEqual(['user-main', 'agent-no-thread', 'tool-main'])
    })

    it('enriches CodexSubAgent blocks with tool-only operation counts', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'tool-call',
                id: 'spawn-call',
                localId: null,
                createdAt: 1,
                threadId: 'thread-main',
                tool: {
                    id: 'spawn-call',
                    name: 'CodexSubAgent',
                    state: 'completed',
                    input: { sender_thread_id: 'thread-main' },
                    result: { receiver_thread_ids: ['thread-sub-1'] },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                    threadId: 'thread-main'
                },
                children: []
            },
            {
                kind: 'tool-call',
                id: 'sub-op-1',
                localId: null,
                createdAt: 3,
                threadId: 'thread-sub-1',
                tool: {
                    id: 'sub-op-1',
                    name: 'CodexBash',
                    state: 'completed',
                    input: { command: 'ls' },
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                    threadId: 'thread-sub-1'
                },
                children: []
            },
            {
                kind: 'agent-text',
                id: 'sub-text',
                localId: null,
                createdAt: 4,
                text: 'not counted',
                threadId: 'thread-sub-1'
            }
        ]

        const filtered = filterBlocksByMainThread(blocks, createRegistry({
            mainThreadId: 'thread-main',
            subAgentThreadIds: new Set(['thread-sub-1']),
            spawnCallIdToThreadId: new Map([['spawn-call', 'thread-sub-1']])
        }))

        expect(filtered).toHaveLength(1)
        expect(filtered[0]?.kind).toBe('tool-call')
        if (filtered[0]?.kind !== 'tool-call') return
        expect(filtered[0].subAgentOperationCount).toBe(1)
    })

    it('builds registry from normalized messages when filtering main chat blocks', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'event-1',
                localId: null,
                createdAt: 1,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'collab_agent_spawn',
                    sender_thread_id: 'thread-main'
                }
            },
            {
                id: 'tool-result-1',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                threadId: 'thread-main',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'spawn-call',
                    content: { receiver_thread_ids: ['thread-sub-1'] },
                    is_error: false,
                    uuid: 'tool-result-1',
                    parentUUID: null,
                    threadId: 'thread-main',
                    receiverThreadIds: ['thread-sub-1']
                }]
            }
        ]

        const blocks: ChatBlock[] = [
            {
                kind: 'tool-call',
                id: 'spawn-call',
                localId: null,
                createdAt: 1,
                threadId: 'thread-main',
                tool: {
                    id: 'spawn-call',
                    name: 'CodexSubAgent',
                    state: 'completed',
                    input: { sender_thread_id: 'thread-main' },
                    result: { receiver_thread_ids: ['thread-sub-1'] },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                    threadId: 'thread-main'
                },
                children: []
            },
            {
                kind: 'tool-call',
                id: 'sub-op-1',
                localId: null,
                createdAt: 3,
                threadId: 'thread-sub-1',
                tool: {
                    id: 'sub-op-1',
                    name: 'CodexBash',
                    state: 'completed',
                    input: { command: 'ls' },
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                    threadId: 'thread-sub-1'
                },
                children: []
            }
        ]

        const filtered = filterMainThreadBlocks(blocks, messages)
        expect(filtered).toHaveLength(1)
        expect(filtered[0]?.kind).toBe('tool-call')
        if (filtered[0]?.kind !== 'tool-call') return
        expect(filtered[0].tool.name).toBe('CodexSubAgent')
        expect(filtered[0].subAgentOperationCount).toBe(1)
    })
})
