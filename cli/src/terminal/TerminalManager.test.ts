import { describe, expect, it, vi } from 'vitest'
import type { TerminalErrorPayload } from '@hapi/protocol'
import type { TerminalBackend, TerminalBackendCreateOptions, TerminalBackendError } from './backend'
import { TerminalManager } from './TerminalManager'

class FakeBackend implements TerminalBackend {
    createCalls: TerminalBackendCreateOptions[] = []
    writeCalls: Array<{ terminalId: string; data: string }> = []
    resizeCalls: Array<{ terminalId: string; cols: number; rows: number }> = []
    closeCalls: string[] = []
    closeAllCalls = 0

    private readyHandler: (terminalId: string) => void = () => { }
    private outputHandler: (terminalId: string, data: string) => void = () => { }
    private exitHandler: (terminalId: string, code: number | null, signal: string | null) => void = () => { }
    private errorHandler: (terminalId: string, error: TerminalBackendError) => void = () => { }

    create(options: TerminalBackendCreateOptions): void {
        this.createCalls.push(options)
    }

    write(terminalId: string, data: string): void {
        this.writeCalls.push({ terminalId, data })
    }

    resize(terminalId: string, cols: number, rows: number): void {
        this.resizeCalls.push({ terminalId, cols, rows })
    }

    close(terminalId: string): void {
        this.closeCalls.push(terminalId)
    }

    closeAll(): void {
        this.closeAllCalls += 1
    }

    onReady(callback: (terminalId: string) => void): void {
        this.readyHandler = callback
    }

    onOutput(callback: (terminalId: string, data: string) => void): void {
        this.outputHandler = callback
    }

    onExit(callback: (terminalId: string, code: number | null, signal: string | null) => void): void {
        this.exitHandler = callback
    }

    onError(callback: (terminalId: string, error: TerminalBackendError) => void): void {
        this.errorHandler = callback
    }

    emitReady(terminalId: string): void {
        this.readyHandler(terminalId)
    }

    emitOutput(terminalId: string, data: string): void {
        this.outputHandler(terminalId, data)
    }

    emitExit(terminalId: string, code: number | null, signal: string | null): void {
        this.exitHandler(terminalId, code, signal)
    }

    emitError(terminalId: string, error: TerminalBackendError): void {
        this.errorHandler(terminalId, error)
    }
}

function createManager(options: {
    backend?: TerminalBackend
    backendFactory?: (platform: NodeJS.Platform) => TerminalBackend
    platform?: NodeJS.Platform
    maxTerminals?: number
    idleTimeoutMs?: number
    onError?: (payload: TerminalErrorPayload) => void
} = {}): TerminalManager {
    return new TerminalManager({
        sessionId: 'session-1',
        getSessionPath: () => process.cwd(),
        onReady: () => { },
        onOutput: () => { },
        onExit: () => { },
        onError: options.onError ?? (() => { }),
        backend: options.backend,
        backendFactory: options.backendFactory,
        platform: options.platform,
        maxTerminals: options.maxTerminals,
        idleTimeoutMs: options.idleTimeoutMs
    })
}

describe('TerminalManager', () => {
    it('selects backend by platform when no backend override is provided', () => {
        const backend = new FakeBackend()
        const backendFactory = vi.fn(() => backend)

        createManager({
            platform: 'win32',
            backendFactory
        })

        expect(backendFactory).toHaveBeenCalledWith('win32')
        expect(backendFactory).toHaveBeenCalledTimes(1)
    })

    it('propagates backend error codes to terminal:error callback', () => {
        const backend = new FakeBackend()
        const errors: TerminalErrorPayload[] = []
        const manager = createManager({
            backend,
            onError: (payload) => errors.push(payload)
        })

        manager.create('terminal-1', 80, 24)
        backend.emitError('terminal-1', {
            code: 'sidecar_protocol_mismatch',
            message: 'protocol mismatch'
        })

        expect(errors).toEqual([
            {
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                code: 'sidecar_protocol_mismatch',
                message: 'protocol mismatch'
            }
        ])
    })

    it('emits structured manager-side errors', () => {
        const backend = new FakeBackend()
        const errors: TerminalErrorPayload[] = []
        const manager = createManager({
            backend,
            maxTerminals: 1,
            onError: (payload) => errors.push(payload)
        })

        manager.create('terminal-1', 80, 24)
        manager.create('terminal-2', 80, 24)
        manager.write('missing', 'echo hi')

        expect(errors.map((error) => error.code)).toEqual(['too_many_terminals', 'terminal_not_found'])
    })
})
