import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { logger } from '@/ui/logger'
import { TerminalErrorCode as TerminalErrorCodeSchema, type ShellOptions, type ShellType, type TerminalErrorCode } from '@hapi/protocol'
import type { TerminalBackend, TerminalBackendCreateOptions, TerminalBackendError } from './backend'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

const HAPI_PTY_PATH_ENV = 'HAPI_PTY_PATH'
const SIDECAR_BINARY_NAME = 'hapi-pty.exe'
const SIDECAR_PROTOCOL_VERSION = 1

const DEFAULT_HELLO_TIMEOUT_MS = 5_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000

type SpawnSidecarProcess = (path: string) => ChildProcessWithoutNullStreams

type SidecarPathResolutionOptions = {
    env?: NodeJS.ProcessEnv
    execPath?: string
    moduleDir?: string
    exists?: (path: string) => boolean
}

type SidecarRequest = {
    type: 'open'
    terminalId: string
    cwd: string
    cols: number
    rows: number
    env: Record<string, string>
    shell?: ShellType
    shellOptions?: ShellOptions
} | {
    type: 'write'
    terminalId: string
    data: string
} | {
    type: 'resize'
    terminalId: string
    cols: number
    rows: number
} | {
    type: 'close'
    terminalId: string
} | {
    type: 'ping'
} | {
    type: 'shutdown'
}

type SidecarEvent = {
    type: 'hello'
    version: string
    protocol: number
} | {
    type: 'ready'
    terminalId: string
    displayName?: string
} | {
    type: 'output'
    terminalId: string
    data: string
} | {
    type: 'exit'
    terminalId: string
    code: number
} | {
    type: 'error'
    terminalId?: string
    code: string
    message: string
} | {
    type: 'pong'
} | {
    type: 'shutdown_ack'
}

type WindowsBackendEvents = {
    onReady: (terminalId: string) => void
    onOutput: (terminalId: string, data: string) => void
    onExit: (terminalId: string, code: number | null, signal: string | null) => void
    onError: (terminalId: string, error: TerminalBackendError) => void
}

type WindowsBackendOptions = {
    spawnProcess?: SpawnSidecarProcess
    resolveSidecarPath?: () => string | null
    helloTimeoutMs?: number
    heartbeatIntervalMs?: number
    heartbeatTimeoutMs?: number
    shutdownTimeoutMs?: number
    protocolVersion?: number
}

type BackendTerminationReason =
    | 'graceful-shutdown'
    | 'heartbeat-timeout'
    | 'protocol-mismatch'
    | 'start-failed'
    | null

class StartError extends Error {
    readonly code: TerminalErrorCode

    constructor(code: TerminalErrorCode, message: string) {
        super(message)
        this.code = code
    }
}

const DEFAULT_EVENTS: WindowsBackendEvents = {
    onReady: () => { },
    onOutput: () => { },
    onExit: () => { },
    onError: () => { }
}

export function getWindowsSidecarPathCandidates(options: SidecarPathResolutionOptions = {}): string[] {
    const env = options.env ?? process.env
    const execPath = options.execPath ?? process.execPath
    const moduleDir = options.moduleDir ?? MODULE_DIR
    const fromEnv = env[HAPI_PTY_PATH_ENV]?.trim()
    const candidates = [
        fromEnv,
        join(dirname(execPath), SIDECAR_BINARY_NAME),
        resolve(moduleDir, '../../bin/hapi-pty.exe')
    ].filter((value): value is string => Boolean(value))
    return [...new Set(candidates)]
}

export function resolveWindowsSidecarPath(options: SidecarPathResolutionOptions = {}): string | null {
    const exists = options.exists ?? existsSync
    const candidates = getWindowsSidecarPathCandidates(options)
    for (const candidate of candidates) {
        if (exists(candidate)) {
            return candidate
        }
    }
    return null
}

export class WindowsBackend implements TerminalBackend {
    private readonly terminalIds: Set<string> = new Set()
    private readonly pendingReadyTerminalIds: Set<string> = new Set()
    private readonly events: WindowsBackendEvents = { ...DEFAULT_EVENTS }

    private readonly spawnProcess: SpawnSidecarProcess
    private readonly sidecarPathResolver: () => string | null
    private readonly helloTimeoutMs: number
    private readonly heartbeatIntervalMs: number
    private readonly heartbeatTimeoutMs: number
    private readonly shutdownTimeoutMs: number
    private readonly protocolVersion: number

    private process: ChildProcessWithoutNullStreams | null = null
    private stdoutInterface: ReadlineInterface | null = null
    private startPromise: Promise<void> | null = null
    private startResolve: (() => void) | null = null
    private startReject: ((error: StartError) => void) | null = null
    private terminationReason: BackendTerminationReason = null
    private waitingForHello = false
    private sidecarReady = false
    private helloTimer: ReturnType<typeof setTimeout> | null = null
    private shutdownTimer: ReturnType<typeof setTimeout> | null = null
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private lastPongAt = 0

    constructor(options: WindowsBackendOptions = {}) {
        this.spawnProcess = options.spawnProcess ?? defaultSpawnSidecarProcess
        this.sidecarPathResolver = options.resolveSidecarPath ?? resolveWindowsSidecarPath
        this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
        this.protocolVersion = options.protocolVersion ?? SIDECAR_PROTOCOL_VERSION
    }

    create(options: TerminalBackendCreateOptions): void {
        if (this.terminalIds.has(options.terminalId)) {
            this.emitError(options.terminalId, 'startup_failed', 'Terminal already exists.')
            return
        }

        this.terminalIds.add(options.terminalId)
        this.pendingReadyTerminalIds.add(options.terminalId)

        void this.ensureSidecarReady()
            .then(() => {
                if (!this.terminalIds.has(options.terminalId)) {
                    return
                }
                const sent = this.sendRequest({
                    type: 'open',
                    terminalId: options.terminalId,
                    cwd: options.cwd,
                    cols: options.cols,
                    rows: options.rows,
                    env: options.env,
                    shell: options.shell,
                    shellOptions: options.shellOptions
                })
                if (!sent) {
                    this.pendingReadyTerminalIds.delete(options.terminalId)
                    this.terminalIds.delete(options.terminalId)
                    this.emitError(options.terminalId, 'sidecar_crashed', 'Failed to communicate with sidecar.')
                }
            })
            .catch((error: unknown) => {
                this.pendingReadyTerminalIds.delete(options.terminalId)
                this.terminalIds.delete(options.terminalId)
                if (error instanceof StartError) {
                    this.emitError(options.terminalId, error.code, error.message)
                    return
                }
                this.emitError(options.terminalId, 'sidecar_crashed', 'Sidecar failed to start.')
            })
    }

    write(terminalId: string, data: string): void {
        if (!this.terminalIds.has(terminalId)) {
            this.emitError(terminalId, 'terminal_not_found', 'Terminal not found.')
            return
        }
        const sent = this.sendRequest({ type: 'write', terminalId, data })
        if (!sent) {
            this.emitError(terminalId, 'sidecar_crashed', 'Failed to communicate with sidecar.')
        }
    }

    resize(terminalId: string, cols: number, rows: number): void {
        if (!this.terminalIds.has(terminalId)) {
            return
        }
        const sent = this.sendRequest({ type: 'resize', terminalId, cols, rows })
        if (!sent) {
            this.emitError(terminalId, 'sidecar_crashed', 'Failed to communicate with sidecar.')
        }
    }

    close(terminalId: string): void {
        if (!this.terminalIds.has(terminalId)) {
            return
        }
        this.pendingReadyTerminalIds.delete(terminalId)
        this.terminalIds.delete(terminalId)
        this.sendRequest({ type: 'close', terminalId })
    }

    closeAll(): void {
        this.pendingReadyTerminalIds.clear()
        this.terminalIds.clear()
        this.requestGracefulShutdown()
    }

    onReady(callback: (terminalId: string) => void): void {
        this.events.onReady = callback
    }

    onOutput(callback: (terminalId: string, data: string) => void): void {
        this.events.onOutput = callback
    }

    onExit(callback: (terminalId: string, code: number | null, signal: string | null) => void): void {
        this.events.onExit = callback
    }

    onError(callback: (terminalId: string, error: TerminalBackendError) => void): void {
        this.events.onError = callback
    }

    private ensureSidecarReady(): Promise<void> {
        if (this.sidecarReady && this.process) {
            return Promise.resolve()
        }
        if (this.startPromise) {
            return this.startPromise
        }

        const sidecarPath = this.sidecarPathResolver()
        if (!sidecarPath) {
            return Promise.reject(new StartError('sidecar_not_found', 'hapi-pty.exe not found.'))
        }

        try {
            this.process = this.spawnProcess(sidecarPath)
        } catch (error) {
            logger.debug('[TERMINAL] Failed to spawn windows sidecar', { error })
            return Promise.reject(new StartError('sidecar_crashed', 'Failed to spawn hapi-pty.exe.'))
        }

        this.sidecarReady = false
        this.waitingForHello = true
        this.terminationReason = null
        this.lastPongAt = 0

        this.startPromise = new Promise<void>((resolve, reject) => {
            this.startResolve = resolve
            this.startReject = reject
        }).finally(() => {
            this.startPromise = null
        })

        this.process.on('error', (error) => {
            logger.debug('[TERMINAL] Windows sidecar process error', { error })
            this.failStart('sidecar_crashed', 'Windows terminal sidecar crashed during startup.', 'start-failed')
        })

        this.process.on('exit', (code, signal) => {
            this.handleProcessExit(code, signal)
        })

        this.stdoutInterface = createInterface({ input: this.process.stdout })
        this.stdoutInterface.on('line', (line) => {
            this.handleLine(line)
        })

        this.process.stderr.on('data', (chunk: Buffer | string) => {
            logger.debug('[TERMINAL] [WINDOWS_SIDECAR] stderr', {
                data: typeof chunk === 'string' ? chunk : chunk.toString('utf8')
            })
        })

        this.helloTimer = setTimeout(() => {
            this.failStart('sidecar_crashed', 'Timed out waiting for sidecar hello.', 'start-failed')
        }, this.helloTimeoutMs)

        return this.startPromise
    }

    private handleLine(line: string): void {
        const trimmed = line.trim()
        if (!trimmed) {
            return
        }

        let event: SidecarEvent
        try {
            event = JSON.parse(trimmed) as SidecarEvent
        } catch (error) {
            logger.debug('[TERMINAL] Invalid sidecar NDJSON line', { error, line: trimmed })
            if (this.waitingForHello) {
                this.failStart('sidecar_crashed', 'Invalid sidecar handshake payload.', 'start-failed')
            }
            return
        }

        if (this.waitingForHello) {
            if (event.type !== 'hello') {
                this.failStart('sidecar_crashed', 'Sidecar did not send hello handshake.', 'start-failed')
                return
            }
            if (event.protocol !== this.protocolVersion) {
                this.failStart(
                    'sidecar_protocol_mismatch',
                    `Sidecar protocol mismatch. Expected ${this.protocolVersion}, got ${event.protocol}.`,
                    'protocol-mismatch'
                )
                return
            }
            this.completeStart()
            return
        }

        switch (event.type) {
            case 'hello':
                return
            case 'ready':
                this.pendingReadyTerminalIds.delete(event.terminalId)
                this.events.onReady(event.terminalId)
                return
            case 'output': {
                const decoded = decodeSidecarOutput(event.data)
                if (decoded.length > 0) {
                    this.events.onOutput(event.terminalId, decoded)
                }
                return
            }
            case 'exit':
                this.pendingReadyTerminalIds.delete(event.terminalId)
                this.terminalIds.delete(event.terminalId)
                this.events.onExit(event.terminalId, event.code, null)
                return
            case 'error': {
                const code = normalizeTerminalErrorCode(event.code)
                if (event.terminalId) {
                    if (this.pendingReadyTerminalIds.has(event.terminalId)) {
                        this.pendingReadyTerminalIds.delete(event.terminalId)
                        this.terminalIds.delete(event.terminalId)
                    }
                    this.emitError(event.terminalId, code, event.message)
                    return
                }
                this.emitErrorToAll(code, event.message)
                return
            }
            case 'pong':
                this.lastPongAt = Date.now()
                return
            case 'shutdown_ack':
                if (this.shutdownTimer) {
                    clearTimeout(this.shutdownTimer)
                    this.shutdownTimer = null
                }
                return
        }
    }

    private completeStart(): void {
        this.waitingForHello = false
        this.sidecarReady = true
        this.lastPongAt = Date.now()
        if (this.helloTimer) {
            clearTimeout(this.helloTimer)
            this.helloTimer = null
        }

        if (this.startResolve) {
            this.startResolve()
        }
        this.startResolve = null
        this.startReject = null
        this.startHeartbeat()
    }

    private failStart(code: TerminalErrorCode, message: string, reason: Exclude<BackendTerminationReason, null>): void {
        if (!this.waitingForHello && !this.startReject) {
            return
        }

        this.waitingForHello = false
        this.sidecarReady = false
        this.terminationReason = reason
        if (this.helloTimer) {
            clearTimeout(this.helloTimer)
            this.helloTimer = null
        }
        if (this.startReject) {
            this.startReject(new StartError(code, message))
        }
        this.startResolve = null
        this.startReject = null
        this.killSidecar()
    }

    private requestGracefulShutdown(): void {
        if (!this.process) {
            return
        }
        this.terminationReason = 'graceful-shutdown'
        this.sendRequest({ type: 'shutdown' })
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer)
        }
        this.shutdownTimer = setTimeout(() => {
            this.killSidecar()
        }, this.shutdownTimeoutMs)
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
        }
        this.heartbeatTimer = setInterval(() => {
            if (!this.process || !this.sidecarReady || this.terminationReason === 'graceful-shutdown') {
                return
            }

            if (Date.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
                this.handleHeartbeatTimeout()
                return
            }

            this.sendRequest({ type: 'ping' })
        }, this.heartbeatIntervalMs)
    }

    private handleHeartbeatTimeout(): void {
        if (!this.process) {
            return
        }
        this.terminationReason = 'heartbeat-timeout'
        this.emitErrorToAll('sidecar_timeout', 'Windows terminal sidecar heartbeat timed out.')
        this.pendingReadyTerminalIds.clear()
        this.terminalIds.clear()
        this.killSidecar()
    }

    private sendRequest(payload: SidecarRequest): boolean {
        if (!this.process || this.process.stdin.destroyed || this.process.killed) {
            return false
        }

        try {
            this.process.stdin.write(`${JSON.stringify(payload)}\n`)
            return true
        } catch (error) {
            logger.debug('[TERMINAL] Failed writing to windows sidecar stdin', { error })
            return false
        }
    }

    private killSidecar(): void {
        if (!this.process || this.process.killed) {
            return
        }
        try {
            this.process.kill('SIGKILL')
        } catch (error) {
            logger.debug('[TERMINAL] Failed to kill windows sidecar', { error })
        }
    }

    private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
        const reason = this.terminationReason
        this.sidecarReady = false
        this.waitingForHello = false

        if (this.stdoutInterface) {
            this.stdoutInterface.removeAllListeners()
            this.stdoutInterface.close()
            this.stdoutInterface = null
        }

        if (this.helloTimer) {
            clearTimeout(this.helloTimer)
            this.helloTimer = null
        }
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer)
            this.shutdownTimer = null
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }

        if (this.startReject) {
            this.startReject(
                new StartError(
                    'sidecar_crashed',
                    `Windows terminal sidecar exited during startup (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}).`
                )
            )
            this.startResolve = null
            this.startReject = null
        }

        this.process = null
        this.terminationReason = null

        if (reason === 'graceful-shutdown' || reason === 'heartbeat-timeout' || reason === 'protocol-mismatch' || reason === 'start-failed') {
            return
        }

        const crashMessage = `Windows terminal sidecar crashed (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}).`
        this.emitErrorToAll('sidecar_crashed', crashMessage)
        this.pendingReadyTerminalIds.clear()
        this.terminalIds.clear()
    }

    private emitErrorToAll(code: TerminalErrorCode, message: string): void {
        for (const terminalId of this.terminalIds) {
            this.emitError(terminalId, code, message)
        }
    }

    private emitError(terminalId: string, code: TerminalErrorCode, message: string): void {
        this.events.onError(terminalId, { code, message })
    }
}

function defaultSpawnSidecarProcess(path: string): ChildProcessWithoutNullStreams {
    return spawn(path, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    })
}

function normalizeTerminalErrorCode(code: unknown): TerminalErrorCode {
    const parsed = TerminalErrorCodeSchema.safeParse(code)
    return parsed.success ? parsed.data : 'unknown'
}

function decodeSidecarOutput(base64Data: string): string {
    try {
        return Buffer.from(base64Data, 'base64').toString('utf8')
    } catch {
        return ''
    }
}
