import { describe, expect, it } from 'bun:test'
import { extractAgentOutputData } from '@hapi/protocol/messages'

describe('extractAgentOutputData fork source session id', () => {
    it('returns sessionId from assistant output payload', () => {
        const parsed = extractAgentOutputData({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'assistant-uuid',
                    sessionId: 'claude-session-a',
                    message: { id: 'msg-1' }
                }
            }
        })

        expect(parsed).toEqual({
            uuid: 'assistant-uuid',
            messageId: 'msg-1',
            sessionId: 'claude-session-a'
        })
    })

    it('supports legacy session_id field', () => {
        const parsed = extractAgentOutputData({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'assistant-uuid',
                    session_id: 'claude-session-b'
                }
            }
        })

        expect(parsed).toEqual({
            uuid: 'assistant-uuid',
            messageId: undefined,
            sessionId: 'claude-session-b'
        })
    })
})
