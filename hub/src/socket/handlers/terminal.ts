import { TerminalAttachPayloadSchema, type TerminalErrorCode as TerminalErrorCodeType, TerminalOpenPayloadSchema } from '@hapi/protocol'
import { z } from 'zod'
import type { TerminalRegistry, TerminalRegistryEntry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'

const terminalCreateSchema = TerminalOpenPayloadSchema
const terminalAttachSchema = TerminalAttachPayloadSchema

const terminalWriteSchema = z.object({
    terminalId: z.string().min(1),
    data: z.string()
})

const terminalResizeSchema = z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

const terminalCloseSchema = z.object({
    terminalId: z.string().min(1),
    sessionId: z.string().min(1).optional()
})

export type TerminalHandlersDeps = {
    io: SocketServer
    getSession: (sessionId: string) => { active: boolean; namespace: string } | null
    terminalRegistry: TerminalRegistry
    maxTerminalsPerSocket: number
    maxTerminalsPerSession: number
}

export function registerTerminalHandlers(socket: SocketWithData, deps: TerminalHandlersDeps): void {
    const { io, getSession, terminalRegistry, maxTerminalsPerSocket, maxTerminalsPerSession } = deps
    const cliNamespace = io.of('/cli')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const emitTerminalError = (sessionId: string, terminalId: string, code: TerminalErrorCodeType, message: string) => {
        socket.emit('terminal:error', { sessionId, terminalId, code, message })
    }

    const resolveEntryForSocket = (terminalId: string): TerminalRegistryEntry | null => {
        const entry = terminalRegistry.get(terminalId)
        if (!entry || entry.socketId !== socket.id) {
            return null
        }
        return entry
    }

    const resolveEntryForClose = (terminalId: string, sessionId?: string): TerminalRegistryEntry | null => {
        const entry = terminalRegistry.get(terminalId)
        if (!entry) {
            return null
        }
        if (entry.socketId === socket.id) {
            return entry
        }
        if (entry.orphanedAt === null || !sessionId || sessionId !== entry.sessionId) {
            return null
        }

        const session = getSession(sessionId)
        if (!namespace || !session || session.namespace !== namespace) {
            return null
        }

        return entry
    }

    const resolveCliSocket = (entry: TerminalRegistryEntry, reportError: boolean): SocketWithData | null => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            terminalRegistry.remove(entry.terminalId)
            if (reportError) {
                emitTerminalError(entry.sessionId, entry.terminalId, 'cli_disconnected', 'CLI disconnected.')
            }
            return null
        }
        return cliSocket
    }

    const emitCloseToCli = (entry: TerminalRegistryEntry): void => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            return
        }
        cliSocket.emit('terminal:close', {
            sessionId: entry.sessionId,
            terminalId: entry.terminalId
        })
    }

    const pickCliSocketId = (sessionId: string): string | null => {
        const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`)
        if (!room || room.size === 0) {
            return null
        }
        for (const socketId of room) {
            const cliSocket = cliNamespace.sockets.get(socketId)
            if (cliSocket && cliSocket.data.namespace === namespace) {
                return cliSocket.id
            }
        }
        return null
    }

    socket.on('terminal:create', (data: unknown) => {
        const parsed = terminalCreateSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, terminalId } = parsed.data
        const session = getSession(sessionId)
        if (!namespace || !session || session.namespace !== namespace || !session.active) {
            emitTerminalError(sessionId, terminalId, 'session_unavailable', 'Session is inactive or unavailable.')
            return
        }

        if (terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
            emitTerminalError(sessionId, terminalId, 'too_many_terminals', `Too many terminals open (max ${maxTerminalsPerSocket}).`)
            return
        }

        if (terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
            emitTerminalError(sessionId, terminalId, 'too_many_terminals', `Too many terminals open for this session (max ${maxTerminalsPerSession}).`)
            return
        }

        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) {
            emitTerminalError(sessionId, terminalId, 'cli_not_connected', 'CLI is not connected for this session.')
            return
        }

        const entry = terminalRegistry.register(terminalId, sessionId, socket.id, cliSocketId)
        if (!entry) {
            emitTerminalError(sessionId, terminalId, 'terminal_already_exists', 'Terminal ID is already in use.')
            return
        }

        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(sessionId, terminalId, 'cli_not_connected', 'CLI is not connected for this session.')
            return
        }

        cliSocket.emit('terminal:open', parsed.data)
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:attach', (data: unknown) => {
        const parsed = terminalAttachSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, terminalId } = parsed.data
        const existingEntry = terminalRegistry.get(terminalId)
        if (existingEntry) {
            const existingCliSocket = cliNamespace.sockets.get(existingEntry.cliSocketId)
            if (!existingCliSocket) {
                terminalRegistry.remove(terminalId)
                emitTerminalError(sessionId, terminalId, 'cli_disconnected', 'CLI disconnected.')
                return
            }
            if (existingCliSocket.data.namespace !== namespace) {
                emitTerminalError(sessionId, terminalId, 'terminal_not_found', 'Terminal not found.')
                return
            }
        }

        const result = terminalRegistry.attachToSocket(terminalId, sessionId, socket.id)
        if ('error' in result) {
            const code: TerminalErrorCodeType = result.error
            const message = code === 'cli_disconnected'
                ? 'CLI disconnected.'
                : 'Terminal not found.'
            emitTerminalError(sessionId, terminalId, code, message)
            return
        }

        const cliSocket = cliNamespace.sockets.get(result.entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(sessionId, terminalId, 'cli_disconnected', 'CLI disconnected.')
            return
        }

        socket.emit('terminal:ready', { sessionId, terminalId })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:write', (data: unknown) => {
        const parsed = terminalWriteSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId, data: payload } = parsed.data
        const entry = resolveEntryForSocket(terminalId)
        if (!entry) {
            return
        }

        const cliSocket = resolveCliSocket(entry, true)
        if (!cliSocket) {
            return
        }
        cliSocket.emit('terminal:write', {
            sessionId: entry.sessionId,
            terminalId,
            data: payload
        })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:resize', (data: unknown) => {
        const parsed = terminalResizeSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId, cols, rows } = parsed.data
        const entry = resolveEntryForSocket(terminalId)
        if (!entry) {
            return
        }

        const cliSocket = resolveCliSocket(entry, true)
        if (!cliSocket) {
            return
        }
        cliSocket.emit('terminal:resize', {
            sessionId: entry.sessionId,
            terminalId,
            cols,
            rows
        })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:close', (data: unknown) => {
        const parsed = terminalCloseSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId, sessionId } = parsed.data
        const entry = resolveEntryForClose(terminalId, sessionId)
        if (!entry) {
            return
        }

        terminalRegistry.remove(terminalId)
        emitCloseToCli(entry)
    })

    socket.on('disconnect', () => {
        terminalRegistry.orphanBySocket(socket.id)
    })
}
