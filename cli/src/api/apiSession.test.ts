import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './types'

const { ioMock } = vi.hoisted(() => ({
    ioMock: vi.fn()
}))

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

import { ApiSessionClient } from './apiSession'
import { TerminalManager } from '@/terminal/TerminalManager'

type SocketHandler = (payload: unknown) => void

class FakeSocket {
    connected = false
    volatile = {
        emit: vi.fn()
    }

    private readonly handlers = new Map<string, SocketHandler[]>()

    on(event: string, handler: SocketHandler): this {
        const existing = this.handlers.get(event) ?? []
        existing.push(handler)
        this.handlers.set(event, existing)
        return this
    }

    off(event: string, handler: SocketHandler): this {
        const existing = this.handlers.get(event)
        if (!existing) {
            return this
        }
        this.handlers.set(event, existing.filter((current) => current !== handler))
        return this
    }

    emit = vi.fn()

    emitWithAck = vi.fn()

    timeout = vi.fn(() => ({
        emitWithAck: vi.fn()
    }))

    connect = vi.fn(() => {
        this.connected = true
        return this
    })

    disconnect = vi.fn(() => {
        this.connected = false
        return this
    })

    trigger(event: string, payload: unknown): void {
        const listeners = this.handlers.get(event) ?? []
        for (const listener of listeners) {
            listener(payload)
        }
    }
}

function createSession(sessionId = 'session-1'): Session {
    return {
        id: sessionId,
        namespace: 'default',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: Date.now()
    }
}

describe('ApiSessionClient terminal:open forwarding', () => {
    let socket: FakeSocket

    beforeEach(() => {
        socket = new FakeSocket()
        ioMock.mockReset()
        ioMock.mockReturnValue(socket as unknown as ReturnType<typeof ioMock>)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('forwards shell and shellOptions to terminal creation', () => {
        const createSpy = vi.spyOn(TerminalManager.prototype, 'create').mockImplementation(() => { })
        const client = new ApiSessionClient('token', createSession())

        socket.trigger('terminal:open', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40,
            shell: 'pwsh',
            shellOptions: {
                wslDistro: 'Ubuntu'
            }
        })

        expect(createSpy).toHaveBeenCalledWith('terminal-1', 120, 40, 'pwsh', { wslDistro: 'Ubuntu' })
        client.close()
    })
})
