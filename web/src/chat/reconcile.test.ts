import { describe, expect, it } from 'vitest'
import { reconcileChatBlocks } from '@/chat/reconcile'
import type { ChatBlock } from '@/chat/types'

describe('reconcileChatBlocks', () => {
    it('does not reuse agent-text blocks when only threadId changes', () => {
        const prevBlock: ChatBlock = {
            kind: 'agent-text',
            id: 'agent-1',
            seq: 1,
            localId: null,
            createdAt: 1,
            text: 'hello',
            threadId: 'thread-main'
        }

        const prevById = new Map([['agent-1', prevBlock]])
        const nextBlock: ChatBlock = {
            ...prevBlock,
            threadId: 'thread-sub'
        }

        const reconciled = reconcileChatBlocks([nextBlock], prevById)
        expect(reconciled.blocks[0]).not.toBe(prevBlock)
    })

    it('does not reuse tool-call blocks when threadId-only fields change', () => {
        const prevBlock: ChatBlock = {
            kind: 'tool-call',
            id: 'tool-1',
            localId: null,
            createdAt: 1,
            threadId: 'thread-main',
            tool: {
                id: 'tool-1',
                name: 'CodexBash',
                state: 'completed',
                input: { command: 'pwd' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                threadId: 'thread-main'
            },
            children: []
        }

        const prevById = new Map([['tool-1', prevBlock]])
        const nextBlock: ChatBlock = {
            ...prevBlock,
            threadId: 'thread-sub',
            tool: {
                ...prevBlock.tool,
                threadId: 'thread-sub'
            }
        }

        const reconciled = reconcileChatBlocks([nextBlock], prevById)
        expect(reconciled.blocks[0]).not.toBe(prevBlock)
    })
})
