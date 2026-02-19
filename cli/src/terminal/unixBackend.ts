import { logger } from '@/ui/logger'
import type { TerminalBackend, TerminalBackendCreateOptions, TerminalBackendError } from './backend'

type UnixRuntime = {
    proc: Bun.Subprocess
    terminal: Bun.Terminal
}

type UnixBackendEvents = {
    onReady: (terminalId: string) => void
    onOutput: (terminalId: string, data: string) => void
    onExit: (terminalId: string, code: number | null, signal: string | null) => void
    onError: (terminalId: string, error: TerminalBackendError) => void
}

const DEFAULT_EVENTS: UnixBackendEvents = {
    onReady: () => { },
    onOutput: () => { },
    onExit: () => { },
    onError: () => { }
}

function resolveShell(): string {
    if (process.env.SHELL) {
        return process.env.SHELL
    }
    if (process.platform === 'darwin') {
        return '/bin/zsh'
    }
    return '/bin/bash'
}

export class UnixBackend implements TerminalBackend {
    private readonly terminals: Map<string, UnixRuntime> = new Map()
    private readonly events: UnixBackendEvents = { ...DEFAULT_EVENTS }

    create(options: TerminalBackendCreateOptions): void {
        if (this.terminals.has(options.terminalId)) {
            this.emitError(options.terminalId, 'startup_failed', 'Terminal already exists.')
            return
        }

        if (typeof Bun === 'undefined' || typeof Bun.spawn !== 'function') {
            this.emitError(options.terminalId, 'runtime_unavailable', 'Terminal is unavailable in this runtime.')
            return
        }

        const decoder = new TextDecoder()

        try {
            const proc = Bun.spawn([resolveShell()], {
                cwd: options.cwd,
                env: options.env,
                terminal: {
                    cols: options.cols,
                    rows: options.rows,
                    data: (_terminal, data) => {
                        const text = decoder.decode(data, { stream: true })
                        if (text) {
                            this.events.onOutput(options.terminalId, text)
                        }
                    },
                    exit: (_terminal, exitCode) => {
                        if (exitCode === 1) {
                            this.emitError(options.terminalId, 'stream_closed', 'Terminal stream closed unexpectedly.')
                        }
                    }
                },
                onExit: (subprocess, exitCode) => {
                    this.terminals.delete(options.terminalId)
                    const signal = subprocess.signalCode ?? null
                    this.events.onExit(options.terminalId, exitCode ?? null, signal)
                }
            })

            const terminal = proc.terminal
            if (!terminal) {
                try {
                    proc.kill()
                } catch (error) {
                    logger.debug('[TERMINAL] Failed to kill process after missing terminal', { error })
                }
                this.emitError(options.terminalId, 'attach_failed', 'Failed to attach terminal.')
                return
            }

            this.terminals.set(options.terminalId, { proc, terminal })
            this.events.onReady(options.terminalId)
        } catch (error) {
            logger.debug('[TERMINAL] Failed to spawn terminal', { error })
            this.emitError(options.terminalId, 'spawn_failed', 'Failed to spawn terminal.')
        }
    }

    write(terminalId: string, data: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            this.emitError(terminalId, 'terminal_not_found', 'Terminal not found.')
            return
        }
        runtime.terminal.write(data)
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            return
        }
        runtime.terminal.resize(cols, rows)
    }

    close(terminalId: string): void {
        const runtime = this.terminals.get(terminalId)
        if (!runtime) {
            return
        }

        this.terminals.delete(terminalId)

        if (!runtime.proc.killed && runtime.proc.exitCode === null) {
            try {
                runtime.proc.kill()
            } catch (error) {
                logger.debug('[TERMINAL] Failed to kill process', { error })
            }
        }

        try {
            runtime.terminal.close()
        } catch (error) {
            logger.debug('[TERMINAL] Failed to close terminal', { error })
        }
    }

    closeAll(): void {
        const terminalIds = [...this.terminals.keys()]
        for (const terminalId of terminalIds) {
            this.close(terminalId)
        }
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

    private emitError(terminalId: string, code: TerminalBackendError['code'], message: string): void {
        this.events.onError(terminalId, { code, message })
    }
}
