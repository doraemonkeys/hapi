import { describe, expect, it } from 'bun:test'
import {
    TerminalAttachPayloadSchema,
    TerminalErrorPayloadSchema,
    TerminalOpenPayloadSchema
} from './socket'

describe('terminal socket schemas', () => {
    it('defaults terminal error code to unknown', () => {
        const result = TerminalErrorPayloadSchema.parse({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'Something failed'
        })

        expect(result.code).toBe('unknown')
    })

    it('rejects invalid terminal error codes', () => {
        const result = TerminalErrorPayloadSchema.safeParse({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'Something failed',
            code: 'bad_code'
        })

        expect(result.success).toBe(false)
    })

    it('accepts p2 shell options on terminal open payload', () => {
        const result = TerminalOpenPayloadSchema.parse({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40,
            shell: 'pwsh',
            shellOptions: {
                wslDistro: 'Ubuntu'
            }
        })

        expect(result.shell).toBe('pwsh')
        expect(result.shellOptions?.wslDistro).toBe('Ubuntu')
    })

    it('rejects non-p2 shells on terminal open payload', () => {
        const result = TerminalOpenPayloadSchema.safeParse({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
            shell: 'wsl'
        })

        expect(result.success).toBe(false)
    })

    it('validates terminal attach payload', () => {
        const success = TerminalAttachPayloadSchema.safeParse({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        const failure = TerminalAttachPayloadSchema.safeParse({
            sessionId: '',
            terminalId: 'terminal-1'
        })

        expect(success.success).toBe(true)
        expect(failure.success).toBe(false)
    })
})
