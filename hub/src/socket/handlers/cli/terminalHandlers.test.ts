import { describe, expect, it } from 'bun:test'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'
import { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'

type EmittedEvent = {
    event: string
    data: unknown
}

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
    readonly emitted: EmittedEvent[] = []
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    constructor(id: string) {
        this.id = id
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    trigger(event: string, data?: unknown): void {
        const handler = this.handlers.get(event)
        if (!handler) {
            return
        }
        if (typeof data === 'undefined') {
            handler()
            return
        }
        handler(data)
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
}

function lastEmit(socket: FakeSocket, event: string): EmittedEvent | undefined {
    return [...socket.emitted].reverse().find((entry) => entry.event === event)
}

describe('cli terminal handlers', () => {
    it('forwards terminal:error with structured code defaults', () => {
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0, keepaliveTimeoutMs: 0 })
        terminalRegistry.register('terminal-1', 'session-1', 'terminal-socket-1', 'cli-socket-1')

        const cliSocket = new FakeSocket('cli-socket-1')
        const terminalSocket = new FakeSocket('terminal-socket-1')
        const terminalNamespace = new FakeNamespace()
        terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as unknown as ReturnType<SocketServer['of']>,
            resolveSessionAccess: () => ({ ok: true, value: { id: 'session-1' } as never }),
            emitAccessError: () => {}
        })

        cliSocket.trigger('terminal:error', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'boom'
        })

        expect(lastEmit(terminalSocket, 'terminal:error')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 'unknown',
            message: 'boom'
        })
    })

    it('cleanup emits cli_disconnected code with session context', () => {
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0, keepaliveTimeoutMs: 0 })
        terminalRegistry.register('terminal-1', 'session-1', 'terminal-socket-1', 'cli-socket-1')

        const cliSocket = new FakeSocket('cli-socket-1')
        const terminalSocket = new FakeSocket('terminal-socket-1')
        const terminalNamespace = new FakeNamespace()
        terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)

        cleanupTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as unknown as ReturnType<SocketServer['of']>
        })

        expect(lastEmit(terminalSocket, 'terminal:error')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 'cli_disconnected',
            message: 'CLI disconnected.'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })
})
