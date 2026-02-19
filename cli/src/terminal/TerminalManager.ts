import { logger } from '@/ui/logger'
import type {
    ShellOptions,
    ShellType,
    TerminalErrorCode,
    TerminalErrorPayload,
    TerminalExitPayload,
    TerminalOutputPayload,
    TerminalReadyPayload
} from '@hapi/protocol'
import type { TerminalBackend } from './backend'
import type { TerminalSession } from './types'
import { UnixBackend } from './unixBackend'
import { WindowsBackend } from './windowsBackend'

type TerminalRuntime = TerminalSession & {
    idleTimer: ReturnType<typeof setTimeout> | null
    ready: boolean
}

type TerminalManagerOptions = {
    sessionId: string
    getSessionPath: () => string | null
    onReady: (payload: TerminalReadyPayload) => void
    onOutput: (payload: TerminalOutputPayload) => void
    onExit: (payload: TerminalExitPayload) => void
    onError: (payload: TerminalErrorPayload) => void
    idleTimeoutMs?: number
    maxTerminals?: number
    platform?: NodeJS.Platform
    backend?: TerminalBackend
    backendFactory?: (platform: NodeJS.Platform) => TerminalBackend
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4
const FATAL_BACKEND_ERROR_CODES = new Set<TerminalErrorCode>([
    'sidecar_crashed',
    'sidecar_timeout',
    'sidecar_protocol_mismatch',
    'sidecar_not_found',
    'stream_closed',
    'terminal_not_found'
])
const SENSITIVE_ENV_KEYS = new Set([
    'CLI_API_TOKEN',
    'HAPI_API_URL',
    'HAPI_HTTP_MCP_URL',
    'TELEGRAM_BOT_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY'
])

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function buildFilteredEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (!value) {
            continue
        }
        if (SENSITIVE_ENV_KEYS.has(key)) {
            continue
        }
        env[key] = value
    }
    return env
}

export function createTerminalBackendForPlatform(platform: NodeJS.Platform): TerminalBackend {
    if (platform === 'win32') {
        return new WindowsBackend()
    }
    return new UnixBackend()
}

export class TerminalManager {
    private readonly sessionId: string
    private readonly getSessionPath: () => string | null
    private readonly onReady: (payload: TerminalReadyPayload) => void
    private readonly onOutput: (payload: TerminalOutputPayload) => void
    private readonly onExit: (payload: TerminalExitPayload) => void
    private readonly onError: (payload: TerminalErrorPayload) => void
    private readonly idleTimeoutMs: number
    private readonly maxTerminals: number
    private readonly terminals: Map<string, TerminalRuntime> = new Map()
    private readonly filteredEnv: Record<string, string>
    private readonly backend: TerminalBackend

    constructor(options: TerminalManagerOptions) {
        this.sessionId = options.sessionId
        this.getSessionPath = options.getSessionPath
        this.onReady = options.onReady
        this.onOutput = options.onOutput
        this.onExit = options.onExit
        this.onError = options.onError
        this.idleTimeoutMs = options.idleTimeoutMs ?? resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
        this.maxTerminals = options.maxTerminals ?? resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
        this.filteredEnv = buildFilteredEnv()
        const platform = options.platform ?? process.platform
        const backendFactory = options.backendFactory ?? createTerminalBackendForPlatform
        this.backend = options.backend ?? backendFactory(platform)
        this.bindBackendEvents()
    }

    create(terminalId: string, cols: number, rows: number, shell?: ShellType, shellOptions?: ShellOptions): void {
        const existing = this.terminals.get(terminalId)
        if (existing) {
            existing.cols = cols
            existing.rows = rows
            this.backend.resize(terminalId, cols, rows)
            this.markActivity(existing)
            this.onReady({ sessionId: this.sessionId, terminalId })
            return
        }

        if (this.terminals.size >= this.maxTerminals) {
            this.emitError(terminalId, 'too_many_terminals', `Too many terminals open (max ${this.maxTerminals}).`)
            return
        }

        const runtime: TerminalRuntime = {
            terminalId,
            cols,
            rows,
            idleTimer: null,
            ready: false
        }

        this.terminals.set(terminalId, runtime)
        this.markActivity(runtime)

        try {
            this.backend.create({
                terminalId,
                cwd: this.getSessionPath() ?? process.cwd(),
                env: this.filteredEnv,
                shell,
                shellOptions,
                cols,
                rows
            })
        } catch (error) {
            logger.debug('[TERMINAL] Backend create failed', { error })
            this.emitError(terminalId, 'spawn_failed', 'Failed to spawn terminal.')
            this.cleanup(terminalId, false)
        }
    }

    write(terminalId: string, data: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            this.emitError(terminalId, 'terminal_not_found', 'Terminal not found.')
            return
        }
        this.backend.write(terminalId, data)
        this.markActivity(runtime)
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            return
        }
        runtime.cols = cols
        runtime.rows = rows
        this.backend.resize(terminalId, cols, rows)
        this.markActivity(runtime)
    }

    close(terminalId: string): void {
        this.cleanup(terminalId, true)
    }

    closeAll(): void {
        for (const runtime of this.terminals.values()) {
            if (runtime.idleTimer) {
                clearTimeout(runtime.idleTimer)
            }
        }
        this.terminals.clear()
        this.backend.closeAll()
    }

    private markActivity(runtime: TerminalRuntime): void {
        this.scheduleIdleTimer(runtime)
    }

    private scheduleIdleTimer(runtime: TerminalRuntime): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (runtime.idleTimer) {
            clearTimeout(runtime.idleTimer)
        }

        runtime.idleTimer = setTimeout(() => {
            this.emitError(runtime.terminalId, 'idle_timeout', 'Terminal closed due to inactivity.')
            this.cleanup(runtime.terminalId, true)
        }, this.idleTimeoutMs)
    }

    private cleanup(terminalId: string, closeBackend: boolean): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            if (closeBackend) {
                this.backend.close(terminalId)
            }
            return
        }

        this.terminals.delete(terminalId)
        if (runtime.idleTimer) {
            clearTimeout(runtime.idleTimer)
        }

        if (closeBackend) {
            try {
                this.backend.close(terminalId)
            } catch (error) {
                logger.debug('[TERMINAL] Failed to close backend terminal', { error })
            }
        }
    }

    private bindBackendEvents(): void {
        this.backend.onReady((terminalId) => {
            const runtime = this.terminals.get(terminalId)
            if (!runtime) {
                return
            }
            runtime.ready = true
            this.markActivity(runtime)
            this.onReady({ sessionId: this.sessionId, terminalId })
        })

        this.backend.onOutput((terminalId, data) => {
            const runtime = this.terminals.get(terminalId)
            if (runtime) {
                this.markActivity(runtime)
            }
            this.onOutput({ sessionId: this.sessionId, terminalId, data })
        })

        this.backend.onExit((terminalId, code, signal) => {
            this.onExit({ sessionId: this.sessionId, terminalId, code, signal })
            this.cleanup(terminalId, false)
        })

        this.backend.onError((terminalId, error) => {
            this.emitError(terminalId, error.code, error.message)
            const runtime = this.terminals.get(terminalId)
            if (!runtime) {
                return
            }
            if (!runtime.ready || FATAL_BACKEND_ERROR_CODES.has(error.code)) {
                this.cleanup(terminalId, false)
            }
        })
    }

    private emitError(terminalId: string, code: TerminalErrorCode, message: string): void {
        this.onError({ sessionId: this.sessionId, terminalId, code, message })
    }
}
