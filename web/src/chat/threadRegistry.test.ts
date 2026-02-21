import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import {
    accumulateThreadRegistry,
    buildThreadRegistry,
    createThreadRegistry,
    createThreadRegistryAccumulator,
    updateRegistry
} from '@/chat/threadRegistry'

function createBaseMessage(id: string, createdAt: number): Pick<NormalizedMessage, 'id' | 'localId' | 'createdAt' | 'isSidechain'> {
    return { id, localId: null, createdAt, isSidechain: false }
}

describe('threadRegistry', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('tracks main thread from sender_thread_id and maps spawn call to receiver thread', () => {
        const messages: NormalizedMessage[] = [
            {
                ...createBaseMessage('spawn-call', 1),
                role: 'agent',
                threadId: 'thread-main',
                content: [{
                    type: 'tool-call',
                    id: 'call-1',
                    name: 'CodexSubAgent',
                    input: { sender_thread_id: 'thread-main' },
                    description: null,
                    uuid: 'uuid-spawn-call',
                    parentUUID: null,
                    threadId: 'thread-main'
                }]
            },
            {
                ...createBaseMessage('spawn-result', 2),
                role: 'agent',
                threadId: 'thread-main',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'call-1',
                    content: { receiver_thread_ids: ['thread-sub-1'] },
                    is_error: false,
                    uuid: 'uuid-spawn-result',
                    parentUUID: null,
                    threadId: 'thread-main',
                    receiverThreadIds: ['thread-sub-1']
                }]
            }
        ]

        const registry = buildThreadRegistry(messages)
        expect(registry.mainThreadId).toBe('thread-main')
        expect(registry.mainThreadSignal).toBe('sender')
        expect(registry.spawnCallIdToThreadId.get('call-1')).toBe('thread-sub-1')
        expect(registry.subAgentThreadIds.has('thread-sub-1')).toBe(true)
    })

    it('prefers explicit isMain thread_started events', () => {
        const registry = updateRegistry(createThreadRegistry(), {
            ...createBaseMessage('thread-started', 1),
            role: 'event',
            threadId: 'thread-main',
            content: {
                type: 'thread_started',
                threadId: 'thread-main',
                isMain: true
            }
        })

        expect(registry.mainThreadId).toBe('thread-main')
        expect(registry.mainThreadSignal).toBe('thread_started_main')
    })

    it('falls back to first thread_started event when no better main thread signal exists', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const registry = updateRegistry(createThreadRegistry(), {
            ...createBaseMessage('thread-started', 1),
            role: 'event',
            threadId: 'thread-fallback',
            content: {
                type: 'thread_started',
                threadId: 'thread-fallback'
            }
        })

        expect(registry.mainThreadId).toBe('thread-fallback')
        expect(registry.mainThreadSignal).toBe('fallback')
        expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('upgrades fallback main thread when a higher-confidence signal arrives', () => {
        let registry = updateRegistry(createThreadRegistry(), {
            ...createBaseMessage('thread-started-fallback', 1),
            role: 'event',
            threadId: 'thread-sub-1',
            content: {
                type: 'thread_started',
                threadId: 'thread-sub-1'
            }
        })

        registry = updateRegistry(registry, {
            ...createBaseMessage('spawn-event', 2),
            role: 'event',
            threadId: 'thread-main',
            content: {
                type: 'collab_agent_spawn',
                sender_thread_id: 'thread-main'
            }
        })

        expect(registry.mainThreadId).toBe('thread-main')
        expect(registry.mainThreadSignal).toBe('sender')
        expect(registry.subAgentThreadIds.has('thread-sub-1')).toBe(true)
        expect(registry.subAgentThreadIds.has('thread-main')).toBe(false)
    })

    it('classifies unknown non-main threadIds as sub-agent threads after main thread is known', () => {
        let registry = updateRegistry(createThreadRegistry(), {
            ...createBaseMessage('spawn-call', 1),
            role: 'agent',
            threadId: 'thread-main',
            content: [{
                type: 'tool-call',
                id: 'call-1',
                name: 'CodexSubAgent',
                input: { sender_thread_id: 'thread-main' },
                description: null,
                uuid: 'uuid-spawn-call',
                parentUUID: null,
                threadId: 'thread-main'
            }]
        })

        registry = updateRegistry(registry, {
            ...createBaseMessage('sub-message', 2),
            role: 'agent',
            threadId: 'thread-sub-unknown',
            content: [{
                type: 'text',
                text: 'sub-agent text',
                uuid: 'uuid-sub-message',
                parentUUID: null,
                threadId: 'thread-sub-unknown'
            }]
        })

        expect(registry.mainThreadId).toBe('thread-main')
        expect(registry.subAgentThreadIds.has('thread-sub-unknown')).toBe(true)
    })

    it('incremental updates match batch registry construction', () => {
        const messages: NormalizedMessage[] = [
            {
                ...createBaseMessage('spawn-call', 1),
                role: 'agent',
                threadId: 'thread-main',
                content: [{
                    type: 'tool-call',
                    id: 'call-1',
                    name: 'CodexSubAgent',
                    input: { sender_thread_id: 'thread-main' },
                    description: null,
                    uuid: 'uuid-spawn-call',
                    parentUUID: null,
                    threadId: 'thread-main'
                }]
            },
            {
                ...createBaseMessage('spawn-result', 2),
                role: 'agent',
                threadId: 'thread-main',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'call-1',
                    content: { receiver_thread_ids: ['thread-sub-1'] },
                    is_error: false,
                    uuid: 'uuid-spawn-result',
                    parentUUID: null,
                    threadId: 'thread-main',
                    receiverThreadIds: ['thread-sub-1']
                }]
            }
        ]

        const incremental = messages.reduce((registry, message) => updateRegistry(registry, message), createThreadRegistry())
        const batch = buildThreadRegistry(messages)

        expect(incremental.mainThreadId).toBe(batch.mainThreadId)
        expect([...incremental.subAgentThreadIds]).toEqual([...batch.subAgentThreadIds])
        expect([...incremental.spawnCallIdToThreadId.entries()]).toEqual([...batch.spawnCallIdToThreadId.entries()])
    })

    it('accumulates incrementally and preserves registry identity when new messages do not change thread data', () => {
        const spawnEvent: NormalizedMessage = {
            ...createBaseMessage('spawn-event', 1),
            role: 'event',
            threadId: 'thread-main',
            content: {
                type: 'collab_agent_spawn',
                sender_thread_id: 'thread-main'
            }
        }

        const mainText: NormalizedMessage = {
            ...createBaseMessage('main-text', 2),
            role: 'agent',
            threadId: 'thread-main',
            content: [{
                type: 'text',
                text: 'main-thread output',
                uuid: 'uuid-main-text',
                parentUUID: null,
                threadId: 'thread-main'
            }]
        }

        let accumulator = accumulateThreadRegistry(createThreadRegistryAccumulator(), [spawnEvent])
        const firstRegistry = accumulator.registry
        accumulator = accumulateThreadRegistry(accumulator, [spawnEvent, mainText])

        expect(accumulator.registry).toBe(firstRegistry)
        expect(accumulator.registry.mainThreadId).toBe('thread-main')
        expect(accumulator.registry.mainThreadSignal).toBe('sender')
    })

    it('handles resume ordering when main thread signal arrives after sub-agent events', () => {
        const messages: NormalizedMessage[] = [
            {
                ...createBaseMessage('spawn-result', 1),
                role: 'agent',
                threadId: 'thread-main',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'call-1',
                    content: { receiver_thread_ids: ['thread-sub-1'] },
                    is_error: false,
                    uuid: 'uuid-spawn-result',
                    parentUUID: null,
                    receiverThreadIds: ['thread-sub-1']
                }]
            },
            {
                ...createBaseMessage('sub-message', 2),
                role: 'agent',
                threadId: 'thread-sub-1',
                content: [{
                    type: 'text',
                    text: 'sub-agent text',
                    uuid: 'uuid-sub-message',
                    parentUUID: null,
                    threadId: 'thread-sub-1'
                }]
            },
            {
                ...createBaseMessage('thread-started-main', 3),
                role: 'event',
                threadId: 'thread-main',
                content: {
                    type: 'thread_started',
                    threadId: 'thread-main',
                    isMain: true
                }
            }
        ]

        const registry = buildThreadRegistry(messages)
        expect(registry.mainThreadId).toBe('thread-main')
        expect(registry.subAgentThreadIds.has('thread-sub-1')).toBe(true)
    })

    it('creates a seeded accumulator with initial mainThreadId', () => {
        const accumulator = createThreadRegistryAccumulator('thread-seed')
        expect(accumulator.registry.mainThreadId).toBe('thread-seed')
        expect(accumulator.registry.mainThreadSignal).toBe('seed')
        expect(accumulator.seed).toBe('thread-seed')
    })

    it('creates an unseeded accumulator when no seed is provided', () => {
        const accumulator = createThreadRegistryAccumulator()
        expect(accumulator.registry.mainThreadId).toBeNull()
        expect(accumulator.registry.mainThreadSignal).toBeNull()
        expect(accumulator.seed).toBeNull()
    })

    it('message-based signal upgrades seed with same mainThreadId', () => {
        const spawnEvent: NormalizedMessage = {
            ...createBaseMessage('spawn-event', 1),
            role: 'event',
            threadId: 'thread-main',
            content: {
                type: 'collab_agent_spawn',
                sender_thread_id: 'thread-main'
            }
        }

        const accumulator = accumulateThreadRegistry(
            createThreadRegistryAccumulator('thread-main'),
            [spawnEvent]
        )

        expect(accumulator.registry.mainThreadId).toBe('thread-main')
        expect(accumulator.registry.mainThreadSignal).toBe('sender')
        expect(accumulator.registry.subAgentThreadIds.size).toBe(0)
    })

    it('message-based signal overrides seed with different mainThreadId', () => {
        const spawnEvent: NormalizedMessage = {
            ...createBaseMessage('spawn-event', 1),
            role: 'event',
            threadId: 'thread-real-main',
            content: {
                type: 'collab_agent_spawn',
                sender_thread_id: 'thread-real-main'
            }
        }

        const accumulator = accumulateThreadRegistry(
            createThreadRegistryAccumulator('thread-seed'),
            [spawnEvent]
        )

        expect(accumulator.registry.mainThreadId).toBe('thread-real-main')
        expect(accumulator.registry.mainThreadSignal).toBe('sender')
        expect(accumulator.registry.subAgentThreadIds.has('thread-seed')).toBe(true)
    })

    it('preserves seed across pagination reset', () => {
        const msg1: NormalizedMessage = {
            ...createBaseMessage('m1', 1),
            role: 'agent',
            threadId: 'thread-sub',
            content: [{
                type: 'text',
                text: 'sub-agent text',
                uuid: 'uuid-m1',
                parentUUID: null,
                threadId: 'thread-sub'
            }]
        }

        const msg2: NormalizedMessage = {
            ...createBaseMessage('m2', 2),
            role: 'agent',
            threadId: 'thread-sub',
            content: [{
                type: 'text',
                text: 'more sub-agent text',
                uuid: 'uuid-m2',
                parentUUID: null,
                threadId: 'thread-sub'
            }]
        }

        // Start with seed and one message
        let accumulator = accumulateThreadRegistry(
            createThreadRegistryAccumulator('thread-main'),
            [msg1]
        )

        // Simulate pagination: different first message triggers full reset
        accumulator = accumulateThreadRegistry(accumulator, [msg2, msg1])

        // Seed preserved through reset
        expect(accumulator.registry.mainThreadId).toBe('thread-main')
        expect(accumulator.seed).toBe('thread-main')
        // thread-sub classified as sub-agent because mainThreadId is known from seed
        expect(accumulator.registry.subAgentThreadIds.has('thread-sub')).toBe(true)
    })
})
