import { memo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { HistorySearchItem } from '@/components/AssistantChat/HistorySearchItem'
import type { SentMessageEntry } from '@/types/api'

interface HistorySearchProps {
    filteredEntries: SentMessageEntry[]
    searchQuery: string
    setSearchQuery: (query: string) => void
    isLoading: boolean
    error: Error | null
    /** Total entries before filtering (for distinguishing empty-state vs no-results) */
    totalEntries: number
    selectedIndex: number
    onSelectedIndexChange: (index: number) => void
    onSelect: (text: string) => void
    onClose: () => void
}

/** Format Unix-ms timestamp as relative time string */
function formatRelativeTime(ms: number, t: (key: string, params?: Record<string, string | number>) => string): string {
    if (!Number.isFinite(ms)) return ''
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

/**
 * FloatingOverlay panel for searching and selecting from sent message history.
 *
 * Renders a search input at top, scrollable results list below, and handles
 * keyboard navigation (up/down/enter/escape).
 */
export const HistorySearch = memo(function HistorySearch(props: HistorySearchProps) {
    const {
        filteredEntries,
        searchQuery,
        setSearchQuery,
        isLoading,
        error,
        totalEntries,
        selectedIndex,
        onSelectedIndexChange,
        onSelect,
        onClose,
    } = props

    const { t } = useTranslation()
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)

    // Auto-focus search input on mount (desktop only — avoids keyboard popup on mobile)
    useEffect(() => {
        if (!('ontouchstart' in window)) {
            inputRef.current?.focus()
        }
    }, [])

    // Scroll selected item into view
    useEffect(() => {
        if (selectedIndex < 0 || selectedIndex >= filteredEntries.length) return
        const listEl = listRef.current
        if (!listEl) return
        const selectedEl = listEl.querySelector<HTMLButtonElement>(
            `[data-history-index="${selectedIndex}"]`
        )
        selectedEl?.scrollIntoView({ block: 'nearest' })
    }, [selectedIndex, filteredEntries.length])

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
        // IME guard
        if (e.nativeEvent.isComposing) return

        if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (filteredEntries.length === 0) return
            onSelectedIndexChange(
                selectedIndex <= 0 ? filteredEntries.length - 1 : selectedIndex - 1
            )
            return
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (filteredEntries.length === 0) return
            onSelectedIndexChange(
                selectedIndex >= filteredEntries.length - 1 ? 0 : selectedIndex + 1
            )
            return
        }

        if (e.key === 'Enter') {
            e.preventDefault()
            const entry = filteredEntries[selectedIndex]
            if (entry) {
                onSelect(entry.text)
            }
            return
        }

        if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            return
        }
    }, [filteredEntries, selectedIndex, onSelectedIndexChange, onSelect, onClose])

    const handleItemClick = useCallback((text: string) => {
        onSelect(text)
    }, [onSelect])

    // Determine body content based on state
    let body: ReactNode

    if (error) {
        body = (
            <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                {t('history.loadError')}
            </div>
        )
    } else if (isLoading) {
        body = (
            <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                {t('loading')}
            </div>
        )
    } else if (totalEntries === 0) {
        body = (
            <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                {t('history.empty')}
            </div>
        )
    } else if (filteredEntries.length === 0) {
        body = (
            <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                {t('history.noResults')}
            </div>
        )
    } else {
        body = (
            <div ref={listRef} role="listbox">
                {filteredEntries.map((entry, index) => (
                    <HistorySearchItem
                        key={`${entry.lastSessionId}-${entry.lastUsedAt}-${index}`}
                        entry={entry}
                        selected={index === selectedIndex}
                        relativeTime={formatRelativeTime(entry.lastUsedAt, t)}
                        onClick={() => handleItemClick(entry.text)}
                        data-history-index={index}
                    />
                ))}
            </div>
        )
    }

    return (
        <div className="absolute bottom-[100%] mb-2 w-full">
            <FloatingOverlay maxHeight={400}>
                <div role="dialog" aria-label={t('history.button')}>
                    {/* Search input */}
                    <div className="border-b border-[var(--app-divider)] px-3 py-2">
                        <input
                            ref={inputRef}
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t('history.searchPlaceholder')}
                            className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                            aria-label={t('history.searchPlaceholder')}
                        />
                    </div>

                    {/* Results body */}
                    {body}
                </div>
            </FloatingOverlay>
        </div>
    )
})
