import { describe, expect, it } from 'vitest'
import { resolveTerminalErrorMessage } from './terminalErrors'

describe('terminal error messages', () => {
    it('returns mapped copy for known error codes', () => {
        expect(resolveTerminalErrorMessage('shell_not_found', 'raw shell message')).toBe(
            'Selected shell is not available on this machine.'
        )
    })

    it('falls back to raw message for unknown codes', () => {
        expect(resolveTerminalErrorMessage('nonexistent_code', 'raw error')).toBe('raw error')
    })

    it('falls back to raw message when code is missing', () => {
        expect(resolveTerminalErrorMessage(undefined, 'raw error')).toBe('raw error')
    })
})
