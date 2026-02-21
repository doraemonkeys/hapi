import { describe, expect, it } from 'vitest'
import { extractMessageThreadId } from '@/chat/extractThreadId'

describe('extractMessageThreadId', () => {
    it('extracts thread_id from direct envelope', () => {
        const content = {
            role: 'agent',
            content: { type: 'codex', data: { thread_id: 'T1', type: 'message' } }
        }
        expect(extractMessageThreadId(content)).toBe('T1')
    })

    it('extracts threadId from wrapped envelope (message wrapper)', () => {
        const content = {
            message: {
                role: 'agent',
                content: { type: 'codex', data: { threadId: 'T2' } }
            }
        }
        expect(extractMessageThreadId(content)).toBe('T2')
    })

    it('returns null for non-agent role', () => {
        const content = {
            role: 'user',
            content: { type: 'codex', data: { thread_id: 'T1' } }
        }
        expect(extractMessageThreadId(content)).toBeNull()
    })

    it('returns null for non-codex type', () => {
        const content = {
            role: 'agent',
            content: { type: 'output', data: { thread_id: 'T1' } }
        }
        expect(extractMessageThreadId(content)).toBeNull()
    })

    it('returns null when threadId is absent', () => {
        const content = {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message' } }
        }
        expect(extractMessageThreadId(content)).toBeNull()
    })

    it('returns null for null input', () => {
        expect(extractMessageThreadId(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
        expect(extractMessageThreadId(undefined)).toBeNull()
    })
})
