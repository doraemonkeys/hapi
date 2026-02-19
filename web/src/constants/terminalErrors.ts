import type { TerminalErrorCode } from '@hapi/protocol'

type KnownTerminalErrorCode = Exclude<TerminalErrorCode, 'unknown'>

export const TERMINAL_ERROR_MESSAGES: Partial<Record<KnownTerminalErrorCode, string>> = {
    shell_not_found: 'Selected shell is not available on this machine.',
    startup_failed: 'Failed to start the selected shell.',
    conpty_unavailable: 'Windows ConPTY is unavailable on this machine.',
    sidecar_crashed: 'Terminal helper crashed. Please create a new terminal.',
    sidecar_not_found: 'Terminal helper is missing on this machine.',
    sidecar_timeout: 'Terminal helper timed out. Please retry.',
    sidecar_protocol_mismatch: 'Terminal helper version mismatch. Please update CLI.',
    too_many_terminals: 'Too many terminals are open. Close one and retry.',
    runtime_unavailable: 'Terminal runtime is unavailable on this machine.',
    spawn_failed: 'Terminal process failed to start.',
    attach_failed: 'Could not reconnect to the previous terminal. Creating a new one.',
    stream_closed: 'Terminal stream closed unexpectedly.',
    idle_timeout: 'Terminal closed after being idle for too long.',
    cli_disconnected: 'CLI disconnected. Reconnect the session and retry.',
    cli_not_connected: 'CLI is not connected for this session.',
    session_unavailable: 'Session is inactive or unavailable.',
    terminal_not_found: 'Previous terminal expired. Creating a new terminal.',
    terminal_already_exists: 'Terminal ID is already in use.'
}

export function resolveTerminalErrorMessage(code: string | undefined, message: string): string {
    if (!code) {
        return message
    }
    return TERMINAL_ERROR_MESSAGES[code as KnownTerminalErrorCode] ?? message
}
