import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'

describe('normalizeAgentRecord', () => {
    it('normalizes codex token_count payload as event', () => {
        const normalized = normalizeAgentRecord(
            'message-1',
            null,
            123,
            {
                type: 'codex',
                data: {
                    type: 'token_count',
                    info: {
                        last: { totalTokens: 1000 }
                    }
                }
            }
        )

        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('event')
        if (!normalized || normalized.role !== 'event') return
        expect(normalized.content.type).toBe('token_count')
    })

    it('normalizes codex thread_started event with thread metadata', () => {
        const normalized = normalizeAgentRecord(
            'message-thread-started',
            null,
            123,
            {
                type: 'codex',
                data: {
                    type: 'event',
                    subtype: 'thread_started',
                    thread_id: 'thread-main',
                    is_main: true
                }
            }
        )

        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('event')
        expect(normalized?.threadId).toBe('thread-main')
        if (!normalized || normalized.role !== 'event') return
        expect(normalized.content).toEqual({
            type: 'thread_started',
            threadId: 'thread-main',
            isMain: true
        })
    })

    it('propagates threadId on codex message and reasoning payloads', () => {
        const message = normalizeAgentRecord(
            'message-text',
            null,
            123,
            {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'hello',
                    thread_id: 'thread-main'
                }
            }
        )
        const reasoning = normalizeAgentRecord(
            'message-reasoning',
            null,
            124,
            {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    message: 'thinking',
                    thread_id: 'thread-sub'
                }
            }
        )

        expect(message?.threadId).toBe('thread-main')
        expect(message?.role).toBe('agent')
        if (message?.role === 'agent') {
            expect(message.content[0]).toMatchObject({ type: 'text', threadId: 'thread-main' })
        }

        expect(reasoning?.threadId).toBe('thread-sub')
        expect(reasoning?.role).toBe('agent')
        if (reasoning?.role === 'agent') {
            expect(reasoning.content[0]).toMatchObject({ type: 'reasoning', threadId: 'thread-sub' })
        }
    })

    it('propagates thread metadata on codex tool call and result payloads', () => {
        const toolCall = normalizeAgentRecord(
            'message-tool-call',
            null,
            123,
            {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'call-1',
                    name: 'CodexSubAgent',
                    input: { sender_thread_id: 'thread-main' },
                    thread_id: 'thread-main'
                }
            }
        )
        const toolResult = normalizeAgentRecord(
            'message-tool-result',
            null,
            124,
            {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'call-1',
                    output: { receiver_thread_ids: ['thread-sub'] },
                    thread_id: 'thread-main'
                }
            }
        )

        expect(toolCall?.role).toBe('agent')
        if (toolCall?.role === 'agent') {
            expect(toolCall.content[0]).toMatchObject({ type: 'tool-call', threadId: 'thread-main' })
        }

        expect(toolResult?.role).toBe('agent')
        if (toolResult?.role === 'agent') {
            expect(toolResult.content[0]).toMatchObject({
                type: 'tool-result',
                threadId: 'thread-main',
                receiverThreadIds: ['thread-sub']
            })
        }
    })
})
