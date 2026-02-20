import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'

describe('reduceChatBlocks', () => {
    it('extracts latest usage from codex token_count events', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'm1',
                localId: null,
                createdAt: 1,
                isSidechain: false,
                role: 'event',
                content: {
                    type: 'token_count',
                    info: {
                        total: {
                            totalTokens: 120000
                        },
                        last: {
                            totalTokens: 42000,
                            inputTokens: 41000,
                            cachedInputTokens: 32000,
                            outputTokens: 1000
                        },
                        modelContextWindow: 258400
                    }
                }
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestUsage?.contextSize).toBe(42000)
        expect(reduced.latestUsage?.inputTokens).toBe(41000)
        expect(reduced.latestUsage?.cacheRead).toBe(32000)
        expect(reduced.latestUsage?.outputTokens).toBe(1000)
        expect(reduced.latestUsage?.modelContextWindow).toBe(258400)
    })

    it('keeps tool block seq from tool-call messages', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'm-tool-call',
                seq: 5,
                localId: null,
                createdAt: 5,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'MCP: Powershell Invoke Expression',
                    input: { command: 'pwd' },
                    description: null,
                    uuid: 'uuid-tool-call',
                    parentUUID: null
                }]
            },
            {
                id: 'm-tool-result',
                seq: 6,
                localId: null,
                createdAt: 6,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'ok',
                    is_error: false,
                    uuid: 'uuid-tool-result',
                    parentUUID: 'uuid-tool-call'
                }]
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]?.kind).toBe('tool-call')
        expect(reduced.blocks[0]?.kind === 'tool-call' ? reduced.blocks[0].seq : undefined).toBe(5)
    })
})
