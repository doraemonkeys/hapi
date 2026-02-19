import { describe, expect, it } from 'bun:test'
import { registerTerminalHandlers } from './terminal'
import { TerminalRegistry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'

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
    readonly adapter = { rooms: new Map<string, Set<string>>() }
}

class FakeServer {
    private readonly namespaces = new Map<string, FakeNamespace>()

    of(name: string): FakeNamespace {
        const existing = this.namespaces.get(name)
        if (existing) {
            return existing
        }
        const namespace = new FakeNamespace()
        this.namespaces.set(name, namespace)
        return namespace
    }
}

type Harness = {
    io: FakeServer
    terminalSocket: FakeSocket
    cliNamespace: FakeNamespace
    terminalRegistry: TerminalRegistry
}

function createHarness(options?: {
    sessionActive?: boolean
    maxTerminalsPerSocket?: number
    maxTerminalsPerSession?: number
    keepaliveTimeoutMs?: number
}): Harness {
    const io = new FakeServer()
    const terminalSocket = new FakeSocket('terminal-socket')
    terminalSocket.data.namespace = 'default'
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs: 0,
        keepaliveTimeoutMs: options?.keepaliveTimeoutMs ?? 0
    })
    const cliNamespace = io.of('/cli')

    registerTerminalHandlers(terminalSocket as unknown as SocketWithData, {
        io: io as unknown as SocketServer,
        getSession: () => ({ active: options?.sessionActive ?? true, namespace: 'default' }),
        terminalRegistry,
        maxTerminalsPerSocket: options?.maxTerminalsPerSocket ?? 4,
        maxTerminalsPerSession: options?.maxTerminalsPerSession ?? 4
    })

    return { io, terminalSocket, cliNamespace, terminalRegistry }
}

function connectCliSocket(cliNamespace: FakeNamespace, cliSocket: FakeSocket, sessionId: string): void {
    cliSocket.data.namespace = 'default'
    cliNamespace.sockets.set(cliSocket.id, cliSocket)
    const roomId = `session:${sessionId}`
    const room = cliNamespace.adapter.rooms.get(roomId) ?? new Set<string>()
    room.add(cliSocket.id)
    cliNamespace.adapter.rooms.set(roomId, room)
}

function lastEmit(socket: FakeSocket, event: string): EmittedEvent | undefined {
    return [...socket.emitted].reverse().find((entry) => entry.event === event)
}

describe('terminal socket handlers', () => {
    it('rejects terminal creation when session is inactive', () => {
        const { terminalSocket, terminalRegistry } = createHarness({ sessionActive: false })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        const errorEvent = lastEmit(terminalSocket, 'terminal:error')
        expect(errorEvent).toBeDefined()
        expect(errorEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 'session_unavailable',
            message: 'Session is inactive or unavailable.'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('opens a terminal and forwards write/resize/close to the CLI socket', () => {
        const { terminalSocket, cliNamespace, terminalRegistry } = createHarness()
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40,
            shell: 'pwsh',
            shellOptions: {
                wslDistro: 'Ubuntu'
            }
        })

        const openEvent = lastEmit(cliSocket, 'terminal:open')
        expect(openEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40,
            shell: 'pwsh',
            shellOptions: {
                wslDistro: 'Ubuntu'
            }
        })
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()

        terminalSocket.trigger('terminal:write', {
            terminalId: 'terminal-1',
            data: 'ls\n'
        })
        const writeEvent = lastEmit(cliSocket, 'terminal:write')
        expect(writeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            data: 'ls\n'
        })

        terminalSocket.trigger('terminal:resize', {
            terminalId: 'terminal-1',
            cols: 100,
            rows: 30
        })
        const resizeEvent = lastEmit(cliSocket, 'terminal:resize')
        expect(resizeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 100,
            rows: 30
        })

        terminalSocket.trigger('terminal:close', {
            terminalId: 'terminal-1'
        })
        const closeEvent = lastEmit(cliSocket, 'terminal:close')
        expect(closeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('marks terminal as orphaned on socket disconnect and supports attach', () => {
        const { io, terminalSocket, cliNamespace, terminalRegistry } = createHarness({ keepaliveTimeoutMs: 50 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 90,
            rows: 24
        })

        terminalSocket.trigger('disconnect')
        expect(lastEmit(cliSocket, 'terminal:close')).toBeUndefined()
        expect(terminalRegistry.get('terminal-1')?.orphanedAt).not.toBeNull()

        const reconnectSocket = new FakeSocket('terminal-socket-2')
        reconnectSocket.data.namespace = 'default'
        registerTerminalHandlers(reconnectSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })
        reconnectSocket.trigger('terminal:attach', {
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })

        const readyEvent = lastEmit(reconnectSocket, 'terminal:ready')
        expect(readyEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        expect(terminalRegistry.get('terminal-1')?.socketId).toBe('terminal-socket-2')
        terminalRegistry.remove('terminal-1')
    })

    it('allows reconnect fallback close to release orphaned terminal immediately', () => {
        const { io, terminalSocket, cliNamespace, terminalRegistry } = createHarness({ keepaliveTimeoutMs: 60_000 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 90,
            rows: 24
        })
        terminalSocket.trigger('disconnect')
        expect(terminalRegistry.get('terminal-1')?.orphanedAt).not.toBeNull()

        const reconnectSocket = new FakeSocket('terminal-socket-2')
        reconnectSocket.data.namespace = 'default'
        registerTerminalHandlers(reconnectSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })

        reconnectSocket.trigger('terminal:close', {
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })

        expect(lastEmit(cliSocket, 'terminal:close')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('rejects reconnect fallback close when session does not match orphan', () => {
        const { io, terminalSocket, cliNamespace, terminalRegistry } = createHarness({ keepaliveTimeoutMs: 60_000 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 90,
            rows: 24
        })
        terminalSocket.trigger('disconnect')

        const reconnectSocket = new FakeSocket('terminal-socket-2')
        reconnectSocket.data.namespace = 'default'
        registerTerminalHandlers(reconnectSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })

        reconnectSocket.trigger('terminal:close', {
            sessionId: 'session-2',
            terminalId: 'terminal-1'
        })

        expect(lastEmit(cliSocket, 'terminal:close')).toBeUndefined()
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()
        terminalRegistry.remove('terminal-1')
    })

    it('does not allow another socket to close a non-orphan terminal', () => {
        const { io, terminalSocket, cliNamespace, terminalRegistry } = createHarness({ keepaliveTimeoutMs: 60_000 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 90,
            rows: 24
        })

        const otherSocket = new FakeSocket('terminal-socket-2')
        otherSocket.data.namespace = 'default'
        registerTerminalHandlers(otherSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })

        otherSocket.trigger('terminal:close', {
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })

        expect(lastEmit(cliSocket, 'terminal:close')).toBeUndefined()
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()
        terminalRegistry.remove('terminal-1')
    })

    it('enforces per-socket terminal limits', () => {
        const { terminalSocket, cliNamespace } = createHarness({ maxTerminalsPerSocket: 1 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-2',
            cols: 80,
            rows: 24
        })

        const errorEvent = lastEmit(terminalSocket, 'terminal:error')
        expect(errorEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-2',
            code: 'too_many_terminals',
            message: 'Too many terminals open (max 1).'
        })
    })

    it('returns terminal_not_found when attach target is unavailable', () => {
        const { io, terminalRegistry } = createHarness()
        const terminalSocket = new FakeSocket('terminal-socket-2')
        terminalSocket.data.namespace = 'default'
        registerTerminalHandlers(terminalSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })

        terminalSocket.trigger('terminal:attach', {
            sessionId: 'session-1',
            terminalId: 'terminal-missing'
        })

        expect(lastEmit(terminalSocket, 'terminal:error')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-missing',
            code: 'terminal_not_found',
            message: 'Terminal not found.'
        })
    })

    it('returns cli_disconnected on attach after CLI cleanup', () => {
        const { io, terminalSocket, cliNamespace, terminalRegistry } = createHarness({ keepaliveTimeoutMs: 50 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })
        terminalSocket.trigger('disconnect')
        terminalRegistry.removeByCliDisconnect(cliSocket.id)

        const reconnectSocket = new FakeSocket('terminal-socket-2')
        reconnectSocket.data.namespace = 'default'
        registerTerminalHandlers(reconnectSocket as unknown as SocketWithData, {
            io: io as unknown as SocketServer,
            getSession: () => ({ active: true, namespace: 'default' }),
            terminalRegistry,
            maxTerminalsPerSocket: 4,
            maxTerminalsPerSession: 4
        })

        reconnectSocket.trigger('terminal:attach', {
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })

        expect(lastEmit(reconnectSocket, 'terminal:error')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 'cli_disconnected',
            message: 'CLI disconnected.'
        })
    })
})
