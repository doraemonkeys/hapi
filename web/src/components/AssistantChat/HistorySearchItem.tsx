import { memo } from 'react'
import type { SentMessageEntry } from '@/types/api'

interface HistorySearchItemProps {
    entry: SentMessageEntry
    selected: boolean
    onClick: () => void
    /** Relative time string for display (e.g. "2 hours ago") */
    relativeTime: string
    /** Data attribute for scroll-into-view targeting */
    'data-history-index'?: number
}

/** Truncate to first line, capped at ~80 chars */
function truncateFirstLine(text: string, maxLen = 80): { display: string; truncated: boolean } {
    const firstLine = text.split('\n')[0] ?? text
    if (firstLine.length <= maxLen) {
        return { display: firstLine, truncated: firstLine !== text }
    }
    return { display: firstLine.slice(0, maxLen), truncated: true }
}

/**
 * Single result row in the history search panel.
 * Displays truncated first line + session name + relative time.
 */
export const HistorySearchItem = memo(function HistorySearchItem(props: HistorySearchItemProps) {
    const { entry, selected, onClick, relativeTime, 'data-history-index': dataHistoryIndex } = props
    const { display, truncated } = truncateFirstLine(entry.text)

    return (
        <button
            type="button"
            role="option"
            aria-selected={selected}
            data-history-index={dataHistoryIndex}
            className={`flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2.5 text-left text-sm transition-colors min-h-[44px] ${
                selected
                    ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                    : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
            }`}
            onClick={onClick}
            onMouseDown={(e) => e.preventDefault()}
        >
            <span className="w-full truncate font-medium">
                {display}{truncated ? '...' : ''}
            </span>
            <span className={`w-full truncate text-xs ${
                selected ? 'opacity-70' : 'text-[var(--app-hint)]'
            }`}>
                {entry.lastSessionName ?? entry.lastSessionId}
                {' \u00B7 '}
                {relativeTime}
            </span>
        </button>
    )
})
