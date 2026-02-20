import { useCallback, useEffect, useRef } from 'react'

const DRAFT_PREFIX = 'hapi:draft:'
const DEBOUNCE_MS = 300

function getDraftKey(sessionId: string): string {
    return `${DRAFT_PREFIX}${sessionId}`
}

/**
 * Persists composer draft text per session in localStorage.
 * Restores on mount/session switch, debounce-saves on change, clears on send.
 */
export function useDraftMessage(
    sessionId: string | undefined,
    composerText: string,
    setComposerText: (text: string) => void,
): { clearDraft: () => void } {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const setTextRef = useRef(setComposerText)
    setTextRef.current = setComposerText

    // Skip the first save per session to avoid overwriting the stored draft
    // with '' before the restore effect populates composerText.
    const saveInitializedRef = useRef<string | null>(null)

    // Restore draft on session change
    useEffect(() => {
        if (!sessionId) return
        const draft = localStorage.getItem(getDraftKey(sessionId))
        if (draft) {
            setTextRef.current(draft)
        }
    }, [sessionId])

    // Debounced save on text change
    useEffect(() => {
        if (!sessionId) return

        // Skip the first run for each session (composerText still stale/empty)
        if (saveInitializedRef.current !== sessionId) {
            saveInitializedRef.current = sessionId
            return
        }

        if (timerRef.current) clearTimeout(timerRef.current)

        timerRef.current = setTimeout(() => {
            if (composerText.trim()) {
                localStorage.setItem(getDraftKey(sessionId), composerText)
            } else {
                localStorage.removeItem(getDraftKey(sessionId))
            }
        }, DEBOUNCE_MS)

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [sessionId, composerText])

    const clearDraft = useCallback(() => {
        if (!sessionId) return
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
        localStorage.removeItem(getDraftKey(sessionId))
    }, [sessionId])

    return { clearDraft }
}
