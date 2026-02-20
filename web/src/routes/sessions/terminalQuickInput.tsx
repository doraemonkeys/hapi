import { useCallback } from 'react'
import type { PointerEvent } from 'react'
import { useLongPress } from '@/hooks/useLongPress'

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

export type TerminalModifier = 'ctrl' | 'alt'

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

function QuickKeyButton(props: {
    input: QuickInput
    disabled: boolean
    isActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: TerminalModifier) => void
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

export function TerminalQuickInputRows(props: {
    disabled: boolean
    ctrlActive: boolean
    altActive: boolean
    onPress: (sequence: string) => void
    onToggleModifier: (modifier: TerminalModifier) => void
}) {
    const { disabled, ctrlActive, altActive, onPress, onToggleModifier } = props

    return QUICK_INPUT_ROWS.map((row, rowIndex) => (
        <div key={`terminal-quick-row-${rowIndex}`} className="flex items-stretch overflow-hidden rounded-md bg-[var(--app-secondary-bg)]">
            {row.map((input) => {
                const modifier = input.modifier
                const isCtrl = modifier === 'ctrl'
                const isAlt = modifier === 'alt'
                const isActive = (isCtrl && ctrlActive) || (isAlt && altActive)
                return (
                    <QuickKeyButton
                        key={input.label}
                        input={input}
                        disabled={disabled}
                        isActive={isActive}
                        onPress={onPress}
                        onToggleModifier={onToggleModifier}
                    />
                )
            })}
        </div>
    ))
}
