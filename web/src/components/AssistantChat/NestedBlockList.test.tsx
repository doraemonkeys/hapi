import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatBlock } from '@/chat/types'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyNestedBlockList } from '@/components/AssistantChat/NestedBlockList'

describe('HappyNestedBlockList', () => {
    it('renders in plain-text mode outside ThreadPrimitive.Messages context', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'u1',
                localId: null,
                createdAt: 1,
                text: 'user line'
            },
            {
                kind: 'agent-text',
                id: 'a1',
                localId: null,
                createdAt: 2,
                text: 'agent line'
            },
            {
                kind: 'agent-reasoning',
                id: 'r1',
                localId: null,
                createdAt: 3,
                text: 'reasoning line'
            },
            {
                kind: 'tool-call',
                id: 't1',
                localId: null,
                createdAt: 4,
                tool: {
                    id: 'tool-1',
                    name: 'CodexBash',
                    state: 'completed',
                    input: { command: 'echo hi' },
                    createdAt: 4,
                    startedAt: 4,
                    completedAt: 5,
                    result: { stdout: 'hi' },
                    description: 'Run shell'
                },
                children: []
            }
        ]

        render(
            <HappyChatProvider
                value={{
                    api: {} as ApiClient,
                    sessionId: 's1',
                    metadata: null,
                    disabled: true,
                    isForkingFromMessage: false,
                    onRefresh: () => undefined
                }}
            >
                <HappyNestedBlockList blocks={blocks} usePlainText />
            </HappyChatProvider>
        )

        expect(screen.getByText('user line')).toBeInTheDocument()
        expect(screen.getByText('agent line')).toBeInTheDocument()
        expect(screen.getByText('reasoning line')).toBeInTheDocument()
        expect(screen.getByText('CodexBash')).toBeInTheDocument()
    })
})
