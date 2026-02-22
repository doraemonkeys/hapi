import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import { extractMessageThreadId } from '@/chat/extractThreadId'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { mergeMessages } from '@/lib/messages'

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingCount: number
    hasMore: boolean
    oldestSeq: number | null
    newestSeq: number | null
    isLoading: boolean
    isLoadingMore: boolean
    warning: string | null
    atBottom: boolean
    messagesVersion: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const PENDING_WINDOW_SIZE = 200
export const MAIN_THREAD_BUDGET = 250
export const SUB_AGENT_BUDGET = 150
const PAGE_SIZE = 50
const PENDING_OVERFLOW_WARNING = 'New messages arrived while you were away. Scroll to bottom to refresh.'

type InternalState = MessageWindowState & {
    pendingOverflowCount: number
    pendingVisibleCount: number
    pendingOverflowVisibleCount: number
}

type PendingVisibilityCacheEntry = {
    source: DecryptedMessage
    visible: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const pendingVisibilityCacheBySession = new Map<string, Map<string, PendingVisibilityCacheEntry>>()
const threadHints = new Map<string, string | null>()
const lastTrimModes = new Map<string, 'append' | 'prepend'>()

function getPendingVisibilityCache(sessionId: string): Map<string, PendingVisibilityCacheEntry> {
    const existing = pendingVisibilityCacheBySession.get(sessionId)
    if (existing) {
        return existing
    }
    const created = new Map<string, PendingVisibilityCacheEntry>()
    pendingVisibilityCacheBySession.set(sessionId, created)
    return created
}

function clearPendingVisibilityCache(sessionId: string): void {
    pendingVisibilityCacheBySession.delete(sessionId)
}

function isVisiblePendingMessage(sessionId: string, message: DecryptedMessage): boolean {
    const cache = getPendingVisibilityCache(sessionId)
    const cached = cache.get(message.id)
    if (cached && cached.source === message) {
        return cached.visible
    }
    const visible = normalizeDecryptedMessage(message) !== null
    cache.set(message.id, { source: message, visible })
    return visible
}

function countVisiblePendingMessages(sessionId: string, messages: DecryptedMessage[]): number {
    let count = 0
    for (const message of messages) {
        if (isVisiblePendingMessage(sessionId, message)) {
            count += 1
        }
    }
    return count
}

function syncPendingVisibilityCache(sessionId: string, pending: DecryptedMessage[]): void {
    const cache = pendingVisibilityCacheBySession.get(sessionId)
    if (!cache) {
        return
    }
    const keep = new Set(pending.map((message) => message.id))
    for (const id of cache.keys()) {
        if (!keep.has(id)) {
            cache.delete(id)
        }
    }
}

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        pending: [],
        pendingCount: 0,
        pendingVisibleCount: 0,
        pendingOverflowVisibleCount: 0,
        hasMore: false,
        oldestSeq: null,
        newestSeq: null,
        isLoading: false,
        isLoadingMore: false,
        warning: null,
        atBottom: true,
        messagesVersion: 0,
        pendingOverflowCount: 0,
    }
}

function getState(sessionId: string): InternalState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notify(sessionId: string): void {
    const subs = listeners.get(sessionId)
    if (!subs) return
    for (const listener of subs) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState): void {
    states.set(sessionId, next)
    notify(sessionId)
}

function updateState(sessionId: string, updater: (prev: InternalState) => InternalState): void {
    const prev = getState(sessionId)
    const next = updater(prev)
    if (next !== prev) {
        setState(sessionId, next)
    }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
    let oldest: number | null = null
    let newest: number | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') {
            continue
        }
        if (oldest === null || message.seq < oldest) {
            oldest = message.seq
        }
        if (newest === null || message.seq > newest) {
            newest = message.seq
        }
    }
    return { oldestSeq: oldest, newestSeq: newest }
}

function buildState(
    prev: InternalState,
    updates: {
        messages?: DecryptedMessage[]
        pending?: DecryptedMessage[]
        pendingOverflowCount?: number
        pendingVisibleCount?: number
        pendingOverflowVisibleCount?: number
        hasMore?: boolean
        isLoading?: boolean
        isLoadingMore?: boolean
        warning?: string | null
        atBottom?: boolean
    }
): InternalState {
    const messages = updates.messages ?? prev.messages
    const pending = updates.pending ?? prev.pending
    const pendingOverflowCount = updates.pendingOverflowCount ?? prev.pendingOverflowCount
    const pendingOverflowVisibleCount = updates.pendingOverflowVisibleCount ?? prev.pendingOverflowVisibleCount
    let pendingVisibleCount = updates.pendingVisibleCount ?? prev.pendingVisibleCount
    const pendingChanged = pending !== prev.pending
    if (pendingChanged && updates.pendingVisibleCount === undefined) {
        pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    }
    if (pendingChanged) {
        syncPendingVisibilityCache(prev.sessionId, pending)
    }
    const pendingCount = pendingVisibleCount + pendingOverflowVisibleCount
    const { oldestSeq, newestSeq } = deriveSeqBounds(messages)
    const messagesVersion = messages === prev.messages ? prev.messagesVersion : prev.messagesVersion + 1

    return {
        ...prev,
        messages,
        pending,
        pendingOverflowCount,
        pendingVisibleCount,
        pendingOverflowVisibleCount,
        pendingCount,
        oldestSeq,
        newestSeq,
        hasMore: updates.hasMore !== undefined ? updates.hasMore : prev.hasMore,
        isLoading: updates.isLoading !== undefined ? updates.isLoading : prev.isLoading,
        isLoadingMore: updates.isLoadingMore !== undefined ? updates.isLoadingMore : prev.isLoadingMore,
        warning: updates.warning !== undefined ? updates.warning : prev.warning,
        atBottom: updates.atBottom !== undefined ? updates.atBottom : prev.atBottom,
        messagesVersion,
    }
}

function trimVisible(
    sessionId: string,
    messages: DecryptedMessage[],
    mode: 'append' | 'prepend'
): DecryptedMessage[] {
    // Record direction for setMainThreadId retrim
    lastTrimModes.set(sessionId, mode)

    if (messages.length <= VISIBLE_WINDOW_SIZE) return messages

    const mainThreadId = threadHints.get(sessionId) ?? null
    if (!mainThreadId) {
        // No hint — original behavior
        return mode === 'prepend'
            ? messages.slice(0, VISIBLE_WINDOW_SIZE)
            : messages.slice(messages.length - VISIBLE_WINDOW_SIZE)
    }

    return trimVisibleByThread(messages, mainThreadId, mode)
}

export function trimVisibleByThread(
    messages: DecryptedMessage[],
    mainThreadId: string,
    mode: 'append' | 'prepend'
): DecryptedMessage[] {
    const mainThread: DecryptedMessage[] = []
    const subAgent: DecryptedMessage[] = []

    for (const msg of messages) {
        const threadId = extractMessageThreadId(msg.content)
        if (threadId === null || threadId === mainThreadId) {
            mainThread.push(msg)
        } else {
            subAgent.push(msg)
        }
    }

    // No sub-agent messages — use full VISIBLE_WINDOW_SIZE (non-Codex sessions have no regression)
    if (subAgent.length === 0) {
        return mode === 'prepend'
            ? messages.slice(0, VISIBLE_WINDOW_SIZE)
            : messages.slice(messages.length - VISIBLE_WINDOW_SIZE)
    }

    const trimmedMain = trimBucket(mainThread, MAIN_THREAD_BUDGET, mode)
    const trimmedSub = trimBucket(subAgent, SUB_AGENT_BUDGET, mode)

    // Nothing trimmed — return same reference
    if (trimmedMain.length === mainThread.length && trimmedSub.length === subAgent.length) {
        return messages
    }

    // Merge back in original order
    return mergeByOriginalOrder(messages, trimmedMain, trimmedSub)
}

export function trimBucket(
    bucket: DecryptedMessage[],
    budget: number,
    mode: 'append' | 'prepend'
): DecryptedMessage[] {
    if (bucket.length <= budget) return bucket
    return mode === 'prepend' ? bucket.slice(0, budget) : bucket.slice(bucket.length - budget)
}

export function mergeByOriginalOrder(
    original: DecryptedMessage[],
    ...buckets: DecryptedMessage[][]
): DecryptedMessage[] {
    const kept = new Set<string>()
    for (const bucket of buckets) {
        for (const msg of bucket) kept.add(msg.id)
    }
    return original.filter((msg) => kept.has(msg.id))
}

function trimPending(
    sessionId: string,
    messages: DecryptedMessage[]
): { pending: DecryptedMessage[]; dropped: number; droppedVisible: number } {
    if (messages.length <= PENDING_WINDOW_SIZE) {
        return { pending: messages, dropped: 0, droppedVisible: 0 }
    }
    const cutoff = messages.length - PENDING_WINDOW_SIZE
    const droppedMessages = messages.slice(0, cutoff)
    const pending = messages.slice(cutoff)
    const droppedVisible = countVisiblePendingMessages(sessionId, droppedMessages)
    return { pending, dropped: droppedMessages.length, droppedVisible }
}

function filterPendingAgainstVisible(pending: DecryptedMessage[], visible: DecryptedMessage[]): DecryptedMessage[] {
    if (pending.length === 0 || visible.length === 0) {
        return pending
    }
    const visibleIds = new Set(visible.map((message) => message.id))
    return pending.filter((message) => !visibleIds.has(message.id))
}

function isOptimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function mergeIntoPending(
    prev: InternalState,
    incoming: DecryptedMessage[]
): {
    pending: DecryptedMessage[]
    pendingVisibleCount: number
    pendingOverflowCount: number
    pendingOverflowVisibleCount: number
    warning: string | null
} {
    if (incoming.length === 0) {
        return {
            pending: prev.pending,
            pendingVisibleCount: prev.pendingVisibleCount,
            pendingOverflowCount: prev.pendingOverflowCount,
            pendingOverflowVisibleCount: prev.pendingOverflowVisibleCount,
            warning: prev.warning
        }
    }
    const mergedPending = mergeMessages(prev.pending, incoming)
    const filtered = filterPendingAgainstVisible(mergedPending, prev.messages)
    const { pending, dropped, droppedVisible } = trimPending(prev.sessionId, filtered)
    const pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    const pendingOverflowCount = prev.pendingOverflowCount + dropped
    const pendingOverflowVisibleCount = prev.pendingOverflowVisibleCount + droppedVisible
    const warning = droppedVisible > 0 && !prev.warning ? PENDING_OVERFLOW_WARNING : prev.warning
    return { pending, pendingVisibleCount, pendingOverflowCount, pendingOverflowVisibleCount, warning }
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function setMainThreadId(sessionId: string, mainThreadId: string | null): void {
    const current = threadHints.get(sessionId) ?? null
    if (current === mainThreadId) return
    // Prevent null degradation: when we already have a non-null hint, ignore incoming null.
    // Only clearMessageWindow / unsubscribe explicitly clear via threadHints.delete().
    if (mainThreadId === null && current !== null) return
    threadHints.set(sessionId, mainThreadId)
    // Immediately retrim with new hint (handles hint arriving after messages)
    const mode = lastTrimModes.get(sessionId) ?? 'append'
    updateState(sessionId, (prev) => {
        if (prev.messages.length === 0) return prev
        const trimmed = trimVisible(sessionId, prev.messages, mode)
        if (trimmed === prev.messages) return prev
        return buildState(prev, { messages: trimmed })
    })
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    const subs = listeners.get(sessionId) ?? new Set()
    subs.add(listener)
    listeners.set(sessionId, subs)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
            states.delete(sessionId)
            clearPendingVisibilityCache(sessionId)
            threadHints.delete(sessionId)
            lastTrimModes.delete(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    clearPendingVisibilityCache(sessionId)
    threadHints.delete(sessionId)
    lastTrimModes.delete(sessionId)
    if (!states.has(sessionId)) {
        return
    }
    setState(sessionId, createState(sessionId))
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
        return
    }
    const source = getState(fromSessionId)
    const base = createState(toSessionId)
    const next = buildState(base, {
        messages: [...source.messages],
        pending: [...source.pending],
        pendingOverflowCount: source.pendingOverflowCount,
        pendingOverflowVisibleCount: source.pendingOverflowVisibleCount,
        hasMore: source.hasMore,
        warning: source.warning,
        atBottom: source.atBottom,
        isLoading: false,
        isLoadingMore: false,
    })
    setState(toSessionId, next)
}

export async function fetchLatestMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoading) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoading: true, warning: null }))

    try {
        // Important: never scope main chat pagination by a single threadId.
        // Fork/resume can produce one session with multiple main-line thread ids.
        // Server-side single-thread filter would hide valid historical messages.
        const response = await api.getMessages(sessionId, { limit: PAGE_SIZE, beforeSeq: null })
        updateState(sessionId, (prev) => {
            if (prev.atBottom) {
                const merged = mergeMessages(prev.messages, [...prev.pending, ...response.messages])
                const trimmed = trimVisible(prev.sessionId, merged, 'append')
                return buildState(prev, {
                    messages: trimmed,
                    pending: [],
                    pendingOverflowCount: 0,
                    pendingVisibleCount: 0,
                    pendingOverflowVisibleCount: 0,
                    hasMore: response.page.hasMore,
                    isLoading: false,
                    warning: null,
                })
            }
            const pendingResult = mergeIntoPending(prev, response.messages)
            return buildState(prev, {
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
                isLoading: false,
                warning: pendingResult.warning,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoading: false, warning: message }))
    }
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string, options?: { limit?: number }): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoadingMore || !initial.hasMore) {
        return
    }
    if (initial.oldestSeq === null) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: true }))

    const limit = options?.limit ?? PAGE_SIZE
    try {
        const response = await api.getMessages(sessionId, { limit, beforeSeq: initial.oldestSeq })
        updateState(sessionId, (prev) => {
            const merged = mergeMessages(response.messages, prev.messages)
            const trimmed = trimVisible(prev.sessionId, merged, 'prepend')
            return buildState(prev, {
                messages: trimmed,
                hasMore: response.page.hasMore,
                isLoadingMore: false,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: false, warning: message }))
    }
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) {
        return
    }
    updateState(sessionId, (prev) => {
        if (prev.atBottom) {
            const merged = mergeMessages(prev.messages, incoming)
            const trimmed = trimVisible(prev.sessionId, merged, 'append')
            const pending = filterPendingAgainstVisible(prev.pending, trimmed)
            return buildState(prev, { messages: trimmed, pending })
        }
        const pendingResult = mergeIntoPending(prev, incoming)
        return buildState(prev, {
            pending: pendingResult.pending,
            pendingVisibleCount: pendingResult.pendingVisibleCount,
            pendingOverflowCount: pendingResult.pendingOverflowCount,
            pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
            warning: pendingResult.warning,
        })
    })
}

export function flushPendingMessages(sessionId: string): boolean {
    const current = getState(sessionId)
    if (current.pending.length === 0 && current.pendingOverflowVisibleCount === 0) {
        return false
    }
    const needsRefresh = current.pendingOverflowVisibleCount > 0
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, prev.pending)
        const trimmed = trimVisible(prev.sessionId, merged, 'append')
        return buildState(prev, {
            messages: trimmed,
            pending: [],
            pendingOverflowCount: 0,
            pendingVisibleCount: 0,
            pendingOverflowVisibleCount: 0,
            warning: needsRefresh ? (prev.warning ?? PENDING_OVERFLOW_WARNING) : prev.warning,
        })
    })
    return needsRefresh
}

export function setAtBottom(sessionId: string, atBottom: boolean): void {
    updateState(sessionId, (prev) => {
        if (prev.atBottom === atBottom) {
            return prev
        }
        return buildState(prev, { atBottom })
    })
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, [message])
        const trimmed = trimVisible(prev.sessionId, merged, 'append')
        const pending = filterPendingAgainstVisible(prev.pending, trimmed)
        return buildState(prev, { messages: trimmed, pending, atBottom: true })
    })
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    if (!localId) {
        return
    }
    updateState(sessionId, (prev) => {
        let changed = false
        const updateList = (list: DecryptedMessage[]) => {
            return list.map((message) => {
                if (message.localId !== localId || !isOptimisticMessage(message)) {
                    return message
                }
                if (message.status === status) {
                    return message
                }
                changed = true
                return { ...message, status }
            })
        }
        const messages = updateList(prev.messages)
        const pending = updateList(prev.pending)
        if (!changed) {
            return prev
        }
        return buildState(prev, { messages, pending })
    })
}
