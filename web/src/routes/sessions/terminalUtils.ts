import type { Terminal } from '@xterm/xterm'

export type ModifierState = {
    ctrl: boolean
    alt: boolean
}

const TERMINAL_ID_STORAGE_KEY_PREFIX = 'hapi:session-terminal-id:'
export const MAX_COPY_LINES = 1200

export function applyModifierState(sequence: string, state: ModifierState): string {
    let modified = sequence
    if (state.alt) {
        modified = `\u001b${modified}`
    }
    if (state.ctrl && modified.length === 1) {
        const code = modified.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
            modified = String.fromCharCode(code - 64)
        }
    }
    return modified
}

export function shouldResetModifiers(sequence: string, state: ModifierState): boolean {
    if (!sequence) {
        return false
    }
    return state.ctrl || state.alt
}

export function createTerminalId(): string {
    if (typeof crypto?.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getTerminalStorageKey(sessionId: string): string {
    return `${TERMINAL_ID_STORAGE_KEY_PREFIX}${sessionId}`
}

export function readStoredTerminalId(sessionId: string): string | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.sessionStorage.getItem(getTerminalStorageKey(sessionId))
    } catch {
        return null
    }
}

export function storeTerminalId(sessionId: string, terminalId: string): void {
    if (typeof window === 'undefined') {
        return
    }
    try {
        window.sessionStorage.setItem(getTerminalStorageKey(sessionId), terminalId)
    } catch {
        // sessionStorage can be unavailable in private browsing or strict settings.
    }
}

export function isTouchDevice(): boolean {
    if (typeof window === 'undefined') {
        return false
    }
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

export function getTerminalSnapshot(terminal: Terminal, maxLines: number): string {
    const buffer = terminal.buffer.active
    const start = Math.max(buffer.length - maxLines, 0)
    const lines: string[] = []
    for (let lineIndex = start; lineIndex < buffer.length; lineIndex += 1) {
        const line = buffer.getLine(lineIndex)
        if (!line) {
            continue
        }
        lines.push(line.translateToString(true))
    }
    return lines.join('\n')
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
    if (!text) {
        return false
    }

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text)
            return true
        } catch {
            // Fall back to execCommand for older mobile webviews.
        }
    }

    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
}
