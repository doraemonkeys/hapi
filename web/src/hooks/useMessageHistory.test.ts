import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SentMessageEntry } from '@/types/api'

// ---------------------------------------------------------------------------
// Mock useMessageHistoryQuery — returns controllable data without network.
// ---------------------------------------------------------------------------

const mockInvalidate = vi.fn()
let mockData: SentMessageEntry[] | undefined
let mockIsLoading = false

vi.mock('@/hooks/queries/useMessageHistoryQuery', () => ({
    useMessageHistoryQuery: () => ({
        data: mockData,
        isLoading: mockIsLoading,
        error: null,
        invalidate: mockInvalidate,
    }),
}))

// Import after mock setup
import { useMessageHistory } from './useMessageHistory'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(text: string, overrides?: Partial<SentMessageEntry>): SentMessageEntry {
    return {
        text,
        lastUsedAt: Date.now(),
        useCount: 1,
        lastSessionId: 'session-1',
        ...overrides,
    }
}

const SAMPLE_ENTRIES: SentMessageEntry[] = [
    makeEntry('fix the auth bug', { lastUsedAt: 3 }),
    makeEntry('add dark mode', { lastUsedAt: 2 }),
    makeEntry('refactor database', { lastUsedAt: 1 }),
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMessageHistory', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        mockData = undefined
        mockIsLoading = false
    })

    describe('entries and loading', () => {
        it('defaults entries to empty array when data is undefined', () => {
            mockData = undefined
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            expect(result.current.entries).toEqual([])
        })

        it('exposes entries from query data', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            expect(result.current.entries).toHaveLength(3)
            expect(result.current.entries[0].text).toBe('fix the auth bug')
        })

        it('exposes isLoading from query', () => {
            mockIsLoading = true
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            expect(result.current.isLoading).toBe(true)
        })

        it('delegates invalidate to query hook', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.invalidate() })
            expect(mockInvalidate).toHaveBeenCalledTimes(1)
        })
    })

    describe('browseUp / browseDown state machine', () => {
        it('browseUp from null enters browse mode at index 0', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            let text: string | undefined
            act(() => { text = result.current.browseUp('my draft') })

            expect(text).toBe('fix the auth bug')
            expect(result.current.browseIndex).toBe(0)
        })

        it('sequential browseUp navigates to older entries', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.browseUp('draft') })
            expect(result.current.browseIndex).toBe(0)

            let text: string | undefined
            act(() => { text = result.current.browseUp('draft') })
            expect(text).toBe('add dark mode')
            expect(result.current.browseIndex).toBe(1)

            act(() => { text = result.current.browseUp('draft') })
            expect(text).toBe('refactor database')
            expect(result.current.browseIndex).toBe(2)
        })

        it('browseUp returns undefined when at the oldest entry', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.browseUp('draft') })
            act(() => { result.current.browseUp('draft') })
            act(() => { result.current.browseUp('draft') })

            let text: string | undefined
            act(() => { text = result.current.browseUp('draft') })
            // Beyond last entry → undefined, index stays at 2
            expect(text).toBeUndefined()
            expect(result.current.browseIndex).toBe(2)
        })

        it('browseDown navigates to newer entries', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            // Browse to index 2 (oldest)
            act(() => { result.current.browseUp('draft') })
            act(() => { result.current.browseUp('draft') })
            act(() => { result.current.browseUp('draft') })
            expect(result.current.browseIndex).toBe(2)

            let text: string | undefined
            act(() => { text = result.current.browseDown() })
            expect(text).toBe('add dark mode')
            expect(result.current.browseIndex).toBe(1)

            act(() => { text = result.current.browseDown() })
            expect(text).toBe('fix the auth bug')
            expect(result.current.browseIndex).toBe(0)
        })

        it('browseDown past newest entry returns saved draft and exits browse mode', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            // Enter browse at index 0 with a draft
            act(() => { result.current.browseUp('my original draft') })
            expect(result.current.browseIndex).toBe(0)

            // Go past newest → restores draft
            let text: string | undefined
            act(() => { text = result.current.browseDown() })
            expect(text).toBe('my original draft')
            expect(result.current.browseIndex).toBeNull()
        })

        it('browseDown returns undefined when not in browse mode', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            let text: string | undefined
            act(() => { text = result.current.browseDown() })
            expect(text).toBeUndefined()
            expect(result.current.browseIndex).toBeNull()
        })

        it('browseUp returns undefined when entries are empty', () => {
            mockData = []
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            let text: string | undefined
            act(() => { text = result.current.browseUp('draft') })
            expect(text).toBeUndefined()
            expect(result.current.browseIndex).toBeNull()
        })

        it('resetBrowse clears browse state', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.browseUp('draft') })
            expect(result.current.browseIndex).toBe(0)

            act(() => { result.current.resetBrowse() })
            expect(result.current.browseIndex).toBeNull()
        })

        it('draft is saved only on first browseUp (null → 0 transition)', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            // First browseUp saves the draft
            act(() => { result.current.browseUp('first draft') })
            // Subsequent browseUp with different text should NOT overwrite draft
            act(() => { result.current.browseUp('should be ignored') })
            act(() => { result.current.browseUp('also ignored') })

            // Navigate back past newest
            act(() => { result.current.browseDown() })
            act(() => { result.current.browseDown() })

            let text: string | undefined
            act(() => { text = result.current.browseDown() })
            // Should return the original draft, not the later arguments
            expect(text).toBe('first draft')
        })
    })

    describe('search filtering', () => {
        it('filteredEntries returns all entries when searchQuery is empty', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            expect(result.current.filteredEntries).toHaveLength(3)
        })

        it('setSearchQuery with immediate empty string filters synchronously', () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            // Set and immediately clear
            act(() => { result.current.setSearchQuery('auth') })
            act(() => { result.current.setSearchQuery('') })

            // Empty query returns all
            expect(result.current.filteredEntries).toHaveLength(3)
        })

        it('search filters entries case-insensitively via includes()', async () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.setSearchQuery('AUTH') })

            // Wait for debounce (150ms)
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 200))
            })

            expect(result.current.filteredEntries).toHaveLength(1)
            expect(result.current.filteredEntries[0].text).toBe('fix the auth bug')
        })

        it('search returns empty when no entries match', async () => {
            mockData = SAMPLE_ENTRIES
            const { result } = renderHook(() => useMessageHistory(null, 'ns'))

            act(() => { result.current.setSearchQuery('zzz_no_match') })

            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 200))
            })

            expect(result.current.filteredEntries).toHaveLength(0)
        })
    })
})
