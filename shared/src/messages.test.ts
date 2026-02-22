import { describe, expect, it } from 'bun:test'
import { extractAgentOutputData } from './messages'

describe('extractAgentOutputData', () => {
    it('extracts Claude assistant output anchors', () => {
        const result = extractAgentOutputData({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'uuid-1',
                    message: { id: 'msg-1' },
                    sessionId: 'claude-session-1'
                }
            }
        })

        expect(result).toEqual({
            uuid: 'uuid-1',
            messageId: 'msg-1',
            sessionId: 'claude-session-1'
        })
    })

    it('extracts Codex turn/thread anchors from codex messages', () => {
        const result = extractAgentOutputData({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    id: 'codex-msg-1',
                    turnId: 'turn-9',
                    thread_id: 'thread-2'
                }
            }
        })

        expect(result).toEqual({
            uuid: 'codex-msg-1',
            messageId: 'turn-9',
            sessionId: 'thread-2'
        })
    })

    it('rejects Codex messages without turnId (not a valid fork anchor)', () => {
        const result = extractAgentOutputData({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id: 'codex-msg-2',
                    threadId: 'thread-3'
                }
            }
        })

        expect(result).toBeNull()
    })
})
