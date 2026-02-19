import type { ShellOptions, ShellType, TerminalErrorCode } from '@hapi/protocol'

export type TerminalBackendCreateOptions = {
    terminalId: string
    cwd: string
    env: Record<string, string>
    shell?: ShellType
    shellOptions?: ShellOptions
    cols: number
    rows: number
}

export type TerminalBackendError = {
    code: TerminalErrorCode
    message: string
}

export interface TerminalBackend {
    create(options: TerminalBackendCreateOptions): void
    write(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    close(terminalId: string): void
    closeAll(): void

    onReady(callback: (terminalId: string) => void): void
    onOutput(callback: (terminalId: string, data: string) => void): void
    onExit(callback: (terminalId: string, code: number | null, signal: string | null) => void): void
    onError(callback: (terminalId: string, error: TerminalBackendError) => void): void
}
