import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { ShellOptions, ShellType } from '@hapi/protocol'
import { resolveTerminalErrorMessage } from '@/constants/terminalErrors'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting'; reconnecting: boolean }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string
    shouldAttachOnInitialConnect?: boolean
    shell?: ShellType
    shellOptions?: ShellOptions
}

type TerminalReadyPayload = {
    terminalId: string
}

type TerminalOutputPayload = {
    terminalId: string
    data: string
}

type TerminalExitPayload = {
    terminalId: string
    code: number | null
    signal: string | null
}

type TerminalErrorPayload = {
    terminalId: string
    message: string
    code?: string
}

const ATTACH_TIMEOUT_MS = 5_000

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    connect: (cols: number, rows: number) => void
    close: () => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    updateTerminalId: (newTerminalId: string) => void
    onOutput: (handler: (data: string) => void) => void
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const shellRef = useRef(options.shell)
    const shellOptionsRef = useRef(options.shellOptions)
    const shouldAttachOnInitialConnectRef = useRef(options.shouldAttachOnInitialConnect ?? false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const hasConnectedRef = useRef(false)
    const attachPendingRef = useRef(false)
    const attachTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.terminalId, options.baseUrl])

    useEffect(() => {
        shellRef.current = options.shell
        shellOptionsRef.current = options.shellOptions
    }, [options.shell, options.shellOptions])

    useEffect(() => {
        shouldAttachOnInitialConnectRef.current = options.shouldAttachOnInitialConnect ?? false
    }, [options.shouldAttachOnInitialConnect])

    useEffect(() => {
        tokenRef.current = options.token
        const socket = socketRef.current
        if (!socket) {
            return
        }
        if (!options.token) {
            if (socket.connected) {
                socket.disconnect()
            }
            return
        }
        socket.auth = { token: options.token }
        if (socket.connected) {
            socket.disconnect()
            socket.connect()
        }
    }, [options.token])

    const isCurrentTerminal = useCallback((terminalId: string) => terminalId === terminalIdRef.current, [])

    const clearAttachTimeout = useCallback(() => {
        if (!attachTimeoutRef.current) {
            return
        }
        clearTimeout(attachTimeoutRef.current)
        attachTimeoutRef.current = null
    }, [])

    const emitCreate = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        attachPendingRef.current = false
        clearAttachTimeout()
        socket.emit('terminal:create', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows,
            shell: shellRef.current,
            shellOptions: shellOptionsRef.current
        })
        setState({ status: 'connecting', reconnecting: false })
    }, [clearAttachTimeout])

    const fallbackCreateAfterAttach = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        attachPendingRef.current = false
        clearAttachTimeout()
        socket.emit('terminal:close', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current
        })
        emitCreate(socket, size)
    }, [clearAttachTimeout, emitCreate])

    const emitAttach = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        attachPendingRef.current = true
        clearAttachTimeout()
        setState({ status: 'connecting', reconnecting: true })
        socket.emit('terminal:attach', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current
        })
        attachTimeoutRef.current = setTimeout(() => {
            if (!attachPendingRef.current) {
                return
            }
            fallbackCreateAfterAttach(socket, size)
        }, ATTACH_TIMEOUT_MS)
    }, [clearAttachTimeout, fallbackCreateAfterAttach])

    const handleInitialConnection = useCallback(
        (socket: Socket, size: { cols: number; rows: number }) => {
            hasConnectedRef.current = true
            const shouldAttach = shouldAttachOnInitialConnectRef.current
            shouldAttachOnInitialConnectRef.current = false
            if (shouldAttach) {
                emitAttach(socket, size)
                return
            }
            emitCreate(socket, size)
        },
        [emitAttach, emitCreate]
    )

    const setErrorState = useCallback((message: string) => {
        attachPendingRef.current = false
        clearAttachTimeout()
        setState({ status: 'error', error: message })
    }, [clearAttachTimeout])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current

        if (!token || !sessionId || !terminalId) {
            setErrorState('Missing terminal credentials.')
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                if (!hasConnectedRef.current) {
                    handleInitialConnection(socket, { cols, rows })
                } else {
                    emitCreate(socket, { cols, rows })
                }
            } else {
                setState({ status: 'connecting', reconnecting: hasConnectedRef.current })
                socket.connect()
            }
            return
        }

        const socket = io(`${baseUrlRef.current}/terminal`, {
            auth: { token },
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            autoConnect: false
        })

        socketRef.current = socket
        setState({ status: 'connecting', reconnecting: false })

        socket.on('connect', () => {
            const size = lastSizeRef.current ?? { cols, rows }
            if (!hasConnectedRef.current) {
                handleInitialConnection(socket, size)
                return
            }
            emitAttach(socket, size)
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            attachPendingRef.current = false
            clearAttachTimeout()
            setState({ status: 'connected' })
        })

        socket.on('terminal:output', (payload: TerminalOutputPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            outputHandlerRef.current(payload.data)
        })

        socket.on('terminal:exit', (payload: TerminalExitPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            exitHandlerRef.current(payload.code, payload.signal)
            setErrorState('Terminal exited.')
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            if (attachPendingRef.current) {
                const size = lastSizeRef.current
                if (size && socket.connected) {
                    fallbackCreateAfterAttach(socket, size)
                    return
                }
            }
            setErrorState(resolveTerminalErrorMessage(payload.code, payload.message))
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            setErrorState(message)
        })

        socket.on('disconnect', (reason) => {
            attachPendingRef.current = false
            clearAttachTimeout()
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setState({ status: 'connecting', reconnecting: true })
        })

        socket.connect()
    }, [handleInitialConnection, emitCreate, emitAttach, fallbackCreateAfterAttach, setErrorState, isCurrentTerminal, clearAttachTimeout])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:write', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            data
        })
    }, [])

    const close = useCallback(() => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:close', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current
        })
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:resize', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols,
            rows
        })
    }, [])

    const disconnect = useCallback(() => {
        const socket = socketRef.current
        if (!socket) {
            return
        }
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        hasConnectedRef.current = false
        attachPendingRef.current = false
        clearAttachTimeout()
        setState({ status: 'idle' })
    }, [clearAttachTimeout])

    const updateTerminalId = useCallback((newTerminalId: string) => {
        terminalIdRef.current = newTerminalId
    }, [])

    const onOutput = useCallback((handler: (data: string) => void) => {
        outputHandlerRef.current = handler
    }, [])

    const onExit = useCallback((handler: (code: number | null, signal: string | null) => void) => {
        exitHandlerRef.current = handler
    }, [])

    return {
        state,
        connect,
        close,
        write,
        resize,
        disconnect,
        updateTerminalId,
        onOutput,
        onExit
    }
}
