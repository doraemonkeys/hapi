import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { propagateMaxSeqInAssistantGroups } from '@/lib/assistant-runtime'

function makeToolBlock(props: { id: string; seq?: number; createdAt: number }): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: props.id,
        seq: props.seq,
        localId: null,
        createdAt: props.createdAt,
        tool: {
            id: props.id,
            name: 'MCP: Powershell Invoke Expression',
            state: 'completed',
            input: { command: 'pwd' },
            createdAt: props.createdAt,
            startedAt: props.createdAt,
            completedAt: props.createdAt + 1,
            description: null,
            result: 'ok'
        },
        children: []
    }
}

describe('propagateMaxSeqInAssistantGroups', () => {
    it('uses max seq when tool calls appear before reasoning/text', () => {
        const blocks: ChatBlock[] = [
            makeToolBlock({ id: 'tool-1', seq: 10, createdAt: 10 }),
            {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                seq: 12,
                localId: null,
                createdAt: 12,
                text: 'Need to run from repo root.'
            },
            {
                kind: 'agent-text',
                id: 'text-1',
                seq: 14,
                localId: null,
                createdAt: 14,
                text: 'Done.'
            }
        ]

        const propagated = propagateMaxSeqInAssistantGroups(blocks)

        expect((propagated[0] as ToolCallBlock).seq).toBe(14)
        expect(propagated[1].kind).toBe('agent-reasoning')
        expect((propagated[1] as Extract<ChatBlock, { kind: 'agent-reasoning' }>).seq).toBe(14)
        expect(propagated[2].kind).toBe('agent-text')
        expect((propagated[2] as Extract<ChatBlock, { kind: 'agent-text' }>).seq).toBe(14)
    })

    it('does not cross event boundaries', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                seq: 7,
                localId: null,
                createdAt: 7,
                text: 'first'
            },
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 8,
                event: { type: 'message', message: 'boundary' }
            },
            {
                kind: 'agent-text',
                id: 'text-2',
                seq: 11,
                localId: null,
                createdAt: 11,
                text: 'second'
            }
        ]

        const propagated = propagateMaxSeqInAssistantGroups(blocks)

        expect((propagated[0] as Extract<ChatBlock, { kind: 'agent-reasoning' }>).seq).toBe(7)
        expect((propagated[2] as Extract<ChatBlock, { kind: 'agent-text' }>).seq).toBe(11)
    })
})
