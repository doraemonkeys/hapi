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
})

