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
})
