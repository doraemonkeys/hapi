import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SentMessageEntry } from '@/types/api'
import { useMessageHistoryQuery } from '@/hooks/queries/useMessageHistoryQuery'

const SEARCH_DEBOUNCE_MS = 150

export interface UseMessageHistory {
    // Data
    entries: SentMessageEntry[]
    isLoading: boolean
    error: Error | null

    // Search (reactive, debounced 150ms internally)
    searchQuery: string
    setSearchQuery: (q: string) => void
    filteredEntries: SentMessageEntry[]

    // Query control
    invalidate(): void

    // Arrow-up browse (local state, not persisted)
    browseIndex: number | null
    /** Navigate to an older entry. Pass current composer text on first call to save as draft. */
    browseUp(currentDraft: string): string | undefined
    /** Navigate to a newer entry. Returns saved draft when browsing past newest. */
    browseDown(): string | undefined
    resetBrowse(): void
}

/**
 * UI state layer for message history.
 *
 * Wraps useMessageHistoryQuery with browse navigation and debounced search.
 * Browse state tracks the current index into the entries array, plus the
 * original draft text so it can be restored when browsing past the newest.
 */
export function useMessageHistory(api: ApiClient | null, namespace: string): UseMessageHistory {
    const { data, isLoading, error, invalidate } = useMessageHistoryQuery(api, namespace)
    const entries = useMemo(() => data ?? [], [data])

    // -- Search state --
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')

    useEffect(() => {
        if (searchQuery === '') {
            setDebouncedQuery('')
            return
        }
        const timer = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [searchQuery])

    const filteredEntries = useMemo(() => {
        if (!debouncedQuery) return entries
        const lower = debouncedQuery.toLowerCase()
        return entries.filter(e => e.text.toLowerCase().includes(lower))
    }, [entries, debouncedQuery])

    // -- Browse state --
    const [browseIndex, setBrowseIndex] = useState<number | null>(null)
    const browseIndexRef = useRef<number | null>(null)
    const draftRef = useRef('')

    const browseUp = useCallback((currentDraft: string): string | undefined => {
        if (entries.length === 0) return undefined

        const current = browseIndexRef.current
        const nextIndex = current === null ? 0 : current + 1
        if (nextIndex >= entries.length) return undefined

        // Save draft on first browse entry (null → 0)
        if (current === null) {
            draftRef.current = currentDraft
        }

        browseIndexRef.current = nextIndex
        setBrowseIndex(nextIndex)
        return entries[nextIndex].text
    }, [entries])

    const browseDown = useCallback((): string | undefined => {
        const current = browseIndexRef.current
        if (current === null) return undefined

        const nextIndex = current - 1
        if (nextIndex < 0) {
            // Past newest entry: restore original draft
            browseIndexRef.current = null
            setBrowseIndex(null)
            return draftRef.current
        }

        browseIndexRef.current = nextIndex
        setBrowseIndex(nextIndex)
        return entries[nextIndex].text
    }, [entries])

    const resetBrowse = useCallback(() => {
        browseIndexRef.current = null
        setBrowseIndex(null)
        draftRef.current = ''
    }, [])

    return {
        entries,
        isLoading,
        error,
        searchQuery,
        setSearchQuery,
        filteredEntries,
        invalidate,
        browseIndex,
        browseUp,
        browseDown,
        resetBrowse,
    }
}
