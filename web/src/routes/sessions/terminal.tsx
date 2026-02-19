import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { useParams } from '@tanstack/react-router'
import type { Terminal } from '@xterm/xterm'
import type { ShellType } from '@hapi/protocol'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTerminalSocket } from '@/hooks/useTerminalSocket'
import { useLongPress } from '@/hooks/useLongPress'
import { useTranslation } from '@/lib/use-translation'
import { TerminalView } from '@/components/Terminal/TerminalView'
import { LoadingState } from '@/components/LoadingState'
import { resolveSessionMachineId, shouldShowWindowsShellPicker } from '@/lib/terminalPlatform'
import { useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
function BackIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function ConnectionIndicator(props: { status: 'idle' | 'connecting' | 'connected' | 'error' }) {
    const isConnected = props.status === 'connected'
    const isConnecting = props.status === 'connecting'
    const label = isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Offline'
    const colorClass = isConnected
        ? 'bg-emerald-500'
        : isConnecting
          ? 'bg-amber-400 animate-pulse'
          : 'bg-[var(--app-hint)]'

    return (
        <div className="flex items-center" aria-label={label} title={label} role="status">
            <span className={`h-2.5 w-2.5 rounded-full ${colorClass}`} />
        </div>
    )
}

type QuickInput = {
    label: string
    sequence?: string
    description: string
    modifier?: 'ctrl' | 'alt'
    popup?: {
        label: string
        sequence: string
        description: string
    }
}

type ModifierState = {
    ctrl: boolean
    alt: boolean
}

function applyModifierState(sequence: string, state: ModifierState): string {
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

function shouldResetModifiers(sequence: string, state: ModifierState): boolean {
    if (!sequence) {
        return false
    }
    return state.ctrl || state.alt
}

const QUICK_INPUT_ROWS: QuickInput[][] = [
    [
        { label: 'Esc', sequence: '\u001b', description: 'Escape' },
        {
            label: '/',
            sequence: '/',
            description: 'Forward slash',
            popup: { label: '?', sequence: '?', description: 'Question mark' },
        },
        {
            label: '-',
            sequence: '-',
            description: 'Hyphen',
            popup: { label: '|', sequence: '|', description: 'Pipe' },
        },
        { label: 'Home', sequence: '\u001b[H', description: 'Home' },
        { label: '↑', sequence: '\u001b[A', description: 'Arrow up' },
        { label: 'End', sequence: '\u001b[F', description: 'End' },
        { label: 'PgUp', sequence: '\u001b[5~', description: 'Page up' },
    ],
    [
        { label: 'Tab', sequence: '\t', description: 'Tab' },
        { label: 'Ctrl', description: 'Control', modifier: 'ctrl' },
        { label: 'Alt', description: 'Alternate', modifier: 'alt' },
        { label: '←', sequence: '\u001b[D', description: 'Arrow left' },
        { label: '↓', sequence: '\u001b[B', description: 'Arrow down' },
        { label: '→', sequence: '\u001b[C', description: 'Arrow right' },
        { label: 'PgDn', sequence: '\u001b[6~', description: 'Page down' },
    ],
]

const SHELL_CHOICES: Array<{ value: ShellType; label: string }> = [
    { value: 'pwsh', label: 'PowerShell (pwsh)' },
    { value: 'powershell', label: 'Windows PowerShell' },
    { value: 'cmd', label: 'Command Prompt (cmd)' }
]

const TERMINAL_ID_STORAGE_KEY_PREFIX = 'hapi:session-terminal-id:'
const MAX_COPY_LINES = 1200

function createTerminalId(): string {
    if (typeof crypto?.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getTerminalStorageKey(sessionId: string): string {
    return `${TERMINAL_ID_STORAGE_KEY_PREFIX}${sessionId}`
}

function readStoredTerminalId(sessionId: string): string | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.sessionStorage.getItem(getTerminalStorageKey(sessionId))
    } catch {
        return null
    }
}

function storeTerminalId(sessionId: string, terminalId: string): void {
    if (typeof window === 'undefined') {
        return
    }
    try {
        window.sessionStorage.setItem(getTerminalStorageKey(sessionId), terminalId)
    } catch {
        // sessionStorage can be unavailable in private browsing or strict settings.
    }
}

function isTouchDevice(): boolean {
    if (typeof window === 'undefined') {
        return false
    }
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

function getTerminalSnapshot(terminal: Terminal, maxLines: number): string {
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

async function copyTextToClipboard(text: string): Promise<boolean> {
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

function QuickKeyButton(props: {
    input: QuickInput
    disabled: boolean
    isActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: 'ctrl' | 'alt') => void
}) {
    const { input, disabled, isActive, onPress, onToggleModifier } = props
    const modifier = input.modifier
    const popupSequence = input.popup?.sequence
    const popupDescription = input.popup?.description
    const hasPopup = Boolean(popupSequence)
    const longPressDisabled = disabled || Boolean(modifier) || !hasPopup

    const handleClick = useCallback(() => {
        if (modifier) {
            onToggleModifier(modifier)
            return
        }
        onPress(input.sequence ?? '')
    }, [modifier, onToggleModifier, onPress, input.sequence])

    const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'touch') {
            event.preventDefault()
        }
    }, [])

    const longPressHandlers = useLongPress({
        onLongPress: () => {
            if (popupSequence && !modifier) {
                onPress(popupSequence)
            }
        },
        onClick: handleClick,
        disabled: longPressDisabled,
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            onPointerDown={handlePointerDown}
            disabled={disabled}
            aria-pressed={modifier ? isActive : undefined}
            className={`flex-1 border-l border-[var(--app-border)] px-1.5 py-1 text-xs font-medium text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent first:border-l-0 active:bg-[var(--app-subtle-bg)] sm:px-3 sm:py-1.5 sm:text-sm ${
                isActive ? 'bg-[var(--app-link)] text-[var(--app-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'
            }`}
            aria-label={input.description}
            title={popupDescription ? `${input.description} (long press: ${popupDescription})` : input.description}
        >
            {input.label}
        </button>
    )
}

export default function TerminalPage() {
    const { t } = useTranslation()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/terminal' })
    const { api, token, baseUrl } = useAppContext()
    const goBack = useAppGoBack()
    const { session } = useSession(api, sessionId)
    const terminalBootstrap = useMemo(() => {
        const storedTerminalId = readStoredTerminalId(sessionId)
        if (storedTerminalId) {
            return { terminalId: storedTerminalId, shouldAttachOnInitialConnect: true }
        }

        const createdTerminalId = createTerminalId()
        storeTerminalId(sessionId, createdTerminalId)
        return { terminalId: createdTerminalId, shouldAttachOnInitialConnect: false }
    }, [sessionId])
    const terminalId = terminalBootstrap.terminalId
    const terminalRef = useRef<Terminal | null>(null)
    const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
    const connectOnceRef = useRef(false)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const modifierStateRef = useRef<ModifierState>({ ctrl: false, alt: false })
    const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
    const [ctrlActive, setCtrlActive] = useState(false)
    const [altActive, setAltActive] = useState(false)
    const [selectedShell, setSelectedShell] = useState<ShellType>('pwsh')
    const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
    const selectedShellOptions = undefined
    const machineId = resolveSessionMachineId(session)
    const shouldFetchMachines = Boolean(session && !session.metadata?.os && machineId)
    const { machines } = useMachines(api, shouldFetchMachines)
    const showWindowsShellPicker = shouldShowWindowsShellPicker(session, machines)
    const { fontSize, increase: increaseFontSize, decrease: decreaseFontSize } = useTerminalFontSize()
    const touchDevice = useMemo(() => isTouchDevice(), [])
    const prevShellRef = useRef(selectedShell)
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false)
    const [manualPasteText, setManualPasteText] = useState('')

    const {
        state: terminalState,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        onExit,
    } = useTerminalSocket({
        token,
        sessionId,
        terminalId,
        shouldAttachOnInitialConnect: terminalBootstrap.shouldAttachOnInitialConnect,
        baseUrl,
        shell: showWindowsShellPicker ? selectedShell : undefined,
        shellOptions: selectedShellOptions
    })

    useEffect(() => {
        onOutput((data) => {
            terminalRef.current?.write(data)
        })
    }, [onOutput])

    useEffect(() => {
        onExit((code, signal) => {
            setExitInfo({ code, signal })
            terminalRef.current?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ''}]`)
            connectOnceRef.current = false
        })
    }, [onExit])

    useEffect(() => {
        modifierStateRef.current = { ctrl: ctrlActive, alt: altActive }
    }, [ctrlActive, altActive])

    useEffect(() => {
        if (!terminalRef.current) {
            return
        }
        const disableInput = terminalState.status === 'connecting' && terminalState.reconnecting
        terminalRef.current.options.disableStdin = disableInput
    }, [terminalState])

    const resetModifiers = useCallback(() => {
        setCtrlActive(false)
        setAltActive(false)
    }, [])

    const dispatchSequence = useCallback(
        (sequence: string, modifierState: ModifierState) => {
            write(applyModifierState(sequence, modifierState))
            if (shouldResetModifiers(sequence, modifierState)) {
                resetModifiers()
            }
        },
        [write, resetModifiers]
    )

    const handleTerminalMount = useCallback(
        (terminal: Terminal) => {
            terminalRef.current = terminal
            inputDisposableRef.current?.dispose()
            inputDisposableRef.current = terminal.onData((data) => {
                const modifierState = modifierStateRef.current
                dispatchSequence(data, modifierState)
            })
        },
        [dispatchSequence]
    )

    const handleResize = useCallback(
        (cols: number, rows: number) => {
            lastSizeRef.current = { cols, rows }
            if (!session?.active) {
                return
            }
            if (!connectOnceRef.current) {
                connectOnceRef.current = true
                connect(cols, rows)
            } else {
                resize(cols, rows)
            }
        },
        [session?.active, connect, resize]
    )

    useEffect(() => {
        if (!session?.active) {
            return
        }
        if (connectOnceRef.current) {
            return
        }
        const size = lastSizeRef.current
        if (!size) {
            return
        }
        connectOnceRef.current = true
        connect(size.cols, size.rows)
    }, [session?.active, connect])

    useEffect(() => {
        connectOnceRef.current = false
        setExitInfo(null)
        disconnect()
    }, [sessionId, disconnect])

    useEffect(() => {
        return () => {
            inputDisposableRef.current?.dispose()
            connectOnceRef.current = false
            disconnect()
        }
    }, [disconnect])

    useEffect(() => {
        if (session?.active === false) {
            disconnect()
            connectOnceRef.current = false
        }
    }, [session?.active, disconnect])

    useEffect(() => {
        if (terminalState.status === 'error') {
            connectOnceRef.current = false
            return
        }
        if (terminalState.status === 'connecting' || terminalState.status === 'connected') {
            setExitInfo(null)
        }
    }, [terminalState.status])

    // Reconnect with new shell when user changes shell selection
    useEffect(() => {
        if (prevShellRef.current === selectedShell) return
        prevShellRef.current = selectedShell

        if (!showWindowsShellPicker || !connectOnceRef.current) return

        disconnect()
        connectOnceRef.current = false
        setExitInfo(null)
        terminalRef.current?.clear()

        const size = lastSizeRef.current
        if (size && session?.active) {
            connectOnceRef.current = true
            connect(size.cols, size.rows)
        }
    }, [selectedShell]) // eslint-disable-line react-hooks/exhaustive-deps

    const quickInputDisabled = !session?.active || terminalState.status !== 'connected'
    const showReconnectLoading = terminalState.status === 'connecting' && terminalState.reconnecting
    const writePlainInput = useCallback((text: string) => {
        if (!text || quickInputDisabled) {
            return false
        }
        write(text)
        resetModifiers()
        terminalRef.current?.focus()
        return true
    }, [quickInputDisabled, write, resetModifiers])

    const handlePasteAction = useCallback(async () => {
        if (quickInputDisabled) {
            return
        }
        const readClipboard = navigator.clipboard?.readText
        if (readClipboard) {
            try {
                const clipboardText = await readClipboard.call(navigator.clipboard)
                if (!clipboardText) {
                    return
                }
                if (writePlainInput(clipboardText)) {
                    return
                }
            } catch {
                // Fall through to manual paste modal.
            }
        }
        setManualPasteText('')
        setPasteDialogOpen(true)
    }, [quickInputDisabled, writePlainInput])

    const handleManualPasteSubmit = useCallback(() => {
        if (!manualPasteText.trim()) {
            return
        }
        if (writePlainInput(manualPasteText)) {
            setPasteDialogOpen(false)
            setManualPasteText('')
        }
    }, [manualPasteText, writePlainInput])
    const handleQuickInput = useCallback(
        (sequence: string) => {
            if (quickInputDisabled) {
                return
            }
            const modifierState = { ctrl: ctrlActive, alt: altActive }
            dispatchSequence(sequence, modifierState)
            terminalRef.current?.focus()
        },
        [quickInputDisabled, ctrlActive, altActive, dispatchSequence]
    )

    const handleModifierToggle = useCallback(
        (modifier: 'ctrl' | 'alt') => {
            if (quickInputDisabled) {
                return
            }
            if (modifier === 'ctrl') {
                setCtrlActive((value) => !value)
                setAltActive(false)
            } else {
                setAltActive((value) => !value)
                setCtrlActive(false)
            }
            terminalRef.current?.focus()
        },
        [quickInputDisabled]
    )

    const handleCopyTerminal = useCallback(async () => {
        const terminal = terminalRef.current
        if (!terminal) {
            return
        }

        const selection = terminal.getSelection().trim()
        const hasSelection = selection.length > 0
        const copyTarget = hasSelection ? selection : getTerminalSnapshot(terminal, MAX_COPY_LINES)
        if (!copyTarget) {
            setCopyFeedback('Nothing to copy')
            return
        }

        const copied = await copyTextToClipboard(copyTarget)
        setCopyFeedback(copied ? (hasSelection ? 'Copied selection' : `Copied last ${MAX_COPY_LINES} lines`) : 'Copy failed')
    }, [])

    useEffect(() => {
        if (!copyFeedback) {
            return
        }
        const timeout = window.setTimeout(() => {
            setCopyFeedback(null)
        }, 2200)
        return () => window.clearTimeout(timeout)
    }, [copyFeedback])

    if (!session) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    const subtitle = session.metadata?.path ?? sessionId
    const status = terminalState.status
    const errorMessage = terminalState.status === 'error' ? terminalState.error : null

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-1.5 p-2 sm:gap-2 sm:p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Terminal</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    {showWindowsShellPicker ? (
                        <label className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                            <span className="hidden sm:inline">Shell</span>
                            <select
                                value={selectedShell}
                                onChange={(event) => {
                                    setSelectedShell(event.target.value as ShellType)
                                }}
                                disabled={terminalState.status === 'connecting'}
                                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] disabled:opacity-60"
                                aria-label="Windows shell"
                            >
                                {SHELL_CHOICES.map((choice) => (
                                    <option key={choice.value} value={choice.value}>
                                        {choice.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    <div className="flex items-center">
                        <button
                            type="button"
                            onClick={decreaseFontSize}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            aria-label="Decrease terminal font size"
                        >
                            A-
                        </button>
                        <button
                            type="button"
                            onClick={increaseFontSize}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            aria-label="Increase terminal font size"
                        >
                            A+
                        </button>
                    </div>
                    {touchDevice ? (
                        <button
                            type="button"
                            onClick={() => {
                                void handleCopyTerminal()
                            }}
                            className="rounded-full border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            aria-label="Copy terminal output"
                        >
                            Copy
                        </button>
                    ) : null}
                    <ConnectionIndicator status={status} />
                </div>
            </div>

            {session.active ? null : (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Terminal is unavailable.
                    </div>
                </div>
            )}

            {errorMessage ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-xs text-[var(--app-badge-error-text)]">
                        {errorMessage}
                    </div>
                </div>
            ) : null}

            {exitInfo ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        Terminal exited{exitInfo.code !== null ? ` with code ${exitInfo.code}` : ''}
                        {exitInfo.signal ? ` (${exitInfo.signal})` : ''}.
                    </div>
                </div>
            ) : null}

            {copyFeedback ? (
                <div className="mx-auto w-full max-w-content px-3 pt-3">
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-xs text-[var(--app-hint)]">
                        {copyFeedback}
                    </div>
                </div>
            ) : null}

            <div className="flex-1 overflow-hidden bg-[var(--app-bg)]">
                <div className="relative h-full w-full p-1 sm:p-3">
                    <TerminalView onMount={handleTerminalMount} onResize={handleResize} fontSize={fontSize} className="h-full w-full" />
                    {showReconnectLoading ? (
                        <div className="absolute inset-1 sm:inset-3 z-10 flex items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--app-bg)_80%,transparent)]">
                            <LoadingState label="Reconnecting…" className="text-sm" />
                        </div>
                    ) : null}
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-t border-[var(--app-border)] pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-1 sm:px-3">
                    <div className="flex flex-col gap-1 py-1 sm:gap-2 sm:py-2">
                        <button
                            type="button"
                            onClick={() => {
                                void handlePasteAction()
                            }}
                            disabled={quickInputDisabled}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {t('button.paste')}
                        </button>
                        {QUICK_INPUT_ROWS.map((row, rowIndex) => (
                            <div
                                key={`terminal-quick-row-${rowIndex}`}
                                className="flex items-stretch overflow-hidden rounded-md bg-[var(--app-secondary-bg)]"
                            >
                                {row.map((input) => {
                                    const modifier = input.modifier
                                    const isCtrl = modifier === 'ctrl'
                                    const isAlt = modifier === 'alt'
                                    const isActive = (isCtrl && ctrlActive) || (isAlt && altActive)
                                    return (
                                        <QuickKeyButton
                                            key={input.label}
                                            input={input}
                                            disabled={quickInputDisabled}
                                            isActive={isActive}
                                            onPress={handleQuickInput}
                                            onToggleModifier={handleModifierToggle}
                                        />
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <Dialog
                open={pasteDialogOpen}
                onOpenChange={(open) => {
                    setPasteDialogOpen(open)
                    if (!open) {
                        setManualPasteText('')
                    }
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('terminal.paste.fallbackTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('terminal.paste.fallbackDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <textarea
                        value={manualPasteText}
                        onChange={(event) => setManualPasteText(event.target.value)}
                        placeholder={t('terminal.paste.placeholder')}
                        className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        autoCapitalize="none"
                        autoCorrect="off"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setPasteDialogOpen(false)
                                setManualPasteText('')
                            }}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleManualPasteSubmit}
                            disabled={!manualPasteText.trim()}
                        >
                            {t('button.paste')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
