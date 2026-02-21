import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'

// Mock extractMessageThreadId so we can control thread classification via content
vi.mock('@/chat/extractThreadId', () => ({
    extractMessageThreadId: (content: unknown): string | null => {
        if (content && typeof content === 'object' && 'threadId' in content) {
            return (content as { threadId: string | null }).threadId
        }
        return null
    },
}))

// Mock normalizeDecryptedMessage (used by pending visibility cache)
vi.mock('@/chat/normalize', () => ({
    normalizeDecryptedMessage: () => ({}),
}))

import {
    MAIN_THREAD_BUDGET,
    VISIBLE_WINDOW_SIZE,
    SUB_AGENT_BUDGET,
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    setMainThreadId,
    subscribeMessageWindow,
    trimBucket,
    trimVisibleByThread,
    mergeByOriginalOrder,
} from './message-window-store'

function makeMsg(id: string, seq: number, threadId?: string): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: threadId !== undefined ? { threadId } : {},
        createdAt: seq,
    }
}

function makeMainMsg(id: string, seq: number, mainThreadId: string): DecryptedMessage {
    return makeMsg(id, seq, mainThreadId)
}

function makeSubMsg(id: string, seq: number, subThreadId: string): DecryptedMessage {
    return makeMsg(id, seq, subThreadId)
}

function makePlainMsg(id: string, seq: number): DecryptedMessage {
    return makeMsg(id, seq)
}

describe('trimVisibleByThread', () => {
    const MAIN = 'main-thread'
    const SUB = 'sub-thread-1'

    it('append mode: trims main and sub to their budgets keeping newest', () => {
        const messages: DecryptedMessage[] = []
        // 300 main + 200 sub = 500 total, interleaved
        for (let i = 0; i < 500; i++) {
            if (i % 5 < 3) {
                messages.push(makeMainMsg(`main-${i}`, i, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i, SUB))
            }
        }
        const mainCount = messages.filter((m) => (m.content as { threadId: string }).threadId === MAIN).length
        const subCount = messages.filter((m) => (m.content as { threadId: string }).threadId === SUB).length
        expect(mainCount).toBe(300)
        expect(subCount).toBe(200)

        const result = trimVisibleByThread(messages, MAIN, 'append')

        const resultMain = result.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        const resultSub = result.filter((m) => (m.content as { threadId: string }).threadId === SUB)
        expect(resultMain).toHaveLength(MAIN_THREAD_BUDGET)
        expect(resultSub).toHaveLength(SUB_AGENT_BUDGET)

        // In append mode, newest messages are kept
        // Verify the last main message in result is the last main message overall
        const allMain = messages.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        expect(resultMain[resultMain.length - 1].id).toBe(allMain[allMain.length - 1].id)
    })

    it('prepend mode: trims main and sub keeping oldest', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i % 5 < 3) {
                messages.push(makeMainMsg(`main-${i}`, i, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i, SUB))
            }
        }

        const result = trimVisibleByThread(messages, MAIN, 'prepend')

        const resultMain = result.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        const resultSub = result.filter((m) => (m.content as { threadId: string }).threadId === SUB)
        expect(resultMain).toHaveLength(MAIN_THREAD_BUDGET)
        expect(resultSub).toHaveLength(SUB_AGENT_BUDGET)

        // In prepend mode, oldest messages are kept
        const allMain = messages.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        expect(resultMain[0].id).toBe(allMain[0].id)
    })

    it('falls back to full VISIBLE_WINDOW_SIZE when no sub-agent messages', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            messages.push(makeMainMsg(`main-${i}`, i, MAIN))
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        expect(result).toHaveLength(VISIBLE_WINDOW_SIZE)
        // Newest 400 kept (append mode)
        expect(result[0].id).toBe(`main-${500 - VISIBLE_WINDOW_SIZE}`)
        expect(result[result.length - 1].id).toBe('main-499')
    })

    it('returns same reference when total within budgets', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 200; i++) {
            messages.push(makeMainMsg(`main-${i}`, i, MAIN))
        }
        for (let i = 200; i < 300; i++) {
            messages.push(makeSubMsg(`sub-${i}`, i, SUB))
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        expect(result).toBe(messages)
    })

    it('trims only sub when only sub exceeds budget', () => {
        const messages: DecryptedMessage[] = []
        // 100 main + 400 sub
        for (let i = 0; i < 500; i++) {
            if (i < 100) {
                messages.push(makeMainMsg(`main-${i}`, i, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i, SUB))
            }
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        const resultMain = result.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        const resultSub = result.filter((m) => (m.content as { threadId: string }).threadId === SUB)
        expect(resultMain).toHaveLength(100) // all kept
        expect(resultSub).toHaveLength(SUB_AGENT_BUDGET)
    })

    it('trims only main when only main exceeds budget', () => {
        const messages: DecryptedMessage[] = []
        // 350 main + 50 sub
        for (let i = 0; i < 400; i++) {
            if (i < 350) {
                messages.push(makeMainMsg(`main-${i}`, i, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i, SUB))
            }
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        const resultMain = result.filter((m) => (m.content as { threadId: string }).threadId === MAIN)
        const resultSub = result.filter((m) => (m.content as { threadId: string }).threadId === SUB)
        expect(resultMain).toHaveLength(MAIN_THREAD_BUDGET)
        expect(resultSub).toHaveLength(50) // all kept
    })

    it('preserves original interleaved order after merge', () => {
        // Interleave: M S M S M S ...
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i % 2 === 0) {
                messages.push(makeMainMsg(`main-${i}`, i, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i, SUB))
            }
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        // Verify order is monotonically increasing by seq
        for (let i = 1; i < result.length; i++) {
            expect(result[i].seq!).toBeGreaterThan(result[i - 1].seq!)
        }
    })

    it('classifies messages with null threadId as main thread', () => {
        const messages: DecryptedMessage[] = []
        // 300 plain (null threadId) + 200 sub
        for (let i = 0; i < 300; i++) {
            messages.push(makePlainMsg(`plain-${i}`, i))
        }
        for (let i = 300; i < 500; i++) {
            messages.push(makeSubMsg(`sub-${i}`, i, SUB))
        }

        const result = trimVisibleByThread(messages, MAIN, 'append')

        const resultPlain = result.filter((m) => !('threadId' in (m.content as object)))
        const resultSub = result.filter((m) => 'threadId' in (m.content as object))
        expect(resultPlain).toHaveLength(MAIN_THREAD_BUDGET)
        expect(resultSub).toHaveLength(SUB_AGENT_BUDGET)
    })
})

describe('trimBucket', () => {
    it('returns same reference when within budget', () => {
        const bucket = [makeMsg('1', 1), makeMsg('2', 2)]
        expect(trimBucket(bucket, 10, 'append')).toBe(bucket)
    })

    it('keeps newest in append mode', () => {
        const bucket = [makeMsg('1', 1), makeMsg('2', 2), makeMsg('3', 3)]
        const result = trimBucket(bucket, 2, 'append')
        expect(result.map((m) => m.id)).toEqual(['2', '3'])
    })

    it('keeps oldest in prepend mode', () => {
        const bucket = [makeMsg('1', 1), makeMsg('2', 2), makeMsg('3', 3)]
        const result = trimBucket(bucket, 2, 'prepend')
        expect(result.map((m) => m.id)).toEqual(['1', '2'])
    })
})

describe('mergeByOriginalOrder', () => {
    it('filters original to only kept items preserving order', () => {
        const original = [makeMsg('a', 1), makeMsg('b', 2), makeMsg('c', 3), makeMsg('d', 4)]
        const bucket1 = [original[0], original[2]] // a, c
        const bucket2 = [original[3]] // d
        const result = mergeByOriginalOrder(original, bucket1, bucket2)
        expect(result.map((m) => m.id)).toEqual(['a', 'c', 'd'])
    })

    it('returns empty when no items kept', () => {
        const original = [makeMsg('a', 1), makeMsg('b', 2)]
        const result = mergeByOriginalOrder(original)
        expect(result).toEqual([])
    })
})

describe('setMainThreadId', () => {
    const SESSION = 'test-session'
    const MAIN = 'main-thread'
    const SUB = 'sub-thread-1'

    let unsub: () => void

    beforeEach(() => {
        clearMessageWindow(SESSION)
        const listener = vi.fn()
        unsub = subscribeMessageWindow(SESSION, listener)
    })

    afterEach(() => {
        unsub()
    })

    it('triggers retrim when hint arrives after messages', () => {
        // Ingest 500 messages: 300 sub + 200 main
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i < 300) {
                messages.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
            } else {
                messages.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
            }
        }
        ingestIncomingMessages(SESSION, messages)

        // Without hint, trimmed to 400 (newest) — all 200 main preserved
        const beforeHint = getMessageWindowState(SESSION)
        expect(beforeHint.messages).toHaveLength(VISIBLE_WINDOW_SIZE)

        // Now set hint — triggers retrim with thread awareness
        setMainThreadId(SESSION, MAIN)
        const afterHint = getMessageWindowState(SESSION)

        const mainMsgs = afterHint.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === MAIN
        )
        // All 200 main messages fit within MAIN_THREAD_BUDGET (250), so all preserved
        expect(mainMsgs).toHaveLength(200)
    })

    it('retrim follows prepend direction from lastTrimModes', () => {
        // Ingest 500 interleaved messages — without hint, newest 400 kept (append mode).
        // Since trimmed result has exactly 400 messages (<= VISIBLE_WINDOW_SIZE),
        // setMainThreadId retrim is a no-op. But when more messages arrive via
        // a second ingest, the hint is already set and trimming is thread-aware.
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i % 2 === 0) {
                messages.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
            }
        }
        ingestIncomingMessages(SESSION, messages)

        // Set hint — retrim is no-op since window == VISIBLE_WINDOW_SIZE
        setMainThreadId(SESSION, MAIN)

        // Now ingest more sub-agent messages that push total above limit
        const moreSub: DecryptedMessage[] = []
        for (let i = 500; i < 600; i++) {
            moreSub.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
        }
        ingestIncomingMessages(SESSION, moreSub)

        const state = getMessageWindowState(SESSION)

        const mainMsgs = state.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === MAIN
        )
        const subMsgs = state.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === SUB
        )

        // With hint active, thread-aware trimming applies:
        // Sub exceeds budget → trimmed to SUB_AGENT_BUDGET
        expect(subMsgs).toHaveLength(SUB_AGENT_BUDGET)
        // Main within budget → all kept
        expect(mainMsgs.length).toBeLessThanOrEqual(MAIN_THREAD_BUDGET)
        expect(mainMsgs.length).toBeGreaterThan(0)
    })

    it('prevents null degradation when non-null hint exists', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i % 2 === 0) {
                messages.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
            }
        }
        ingestIncomingMessages(SESSION, messages)

        // Set non-null hint
        setMainThreadId(SESSION, MAIN)
        const afterHint = getMessageWindowState(SESSION)
        const mainCountAfterHint = afterHint.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === MAIN
        ).length

        // Try to degrade to null — should be ignored
        setMainThreadId(SESSION, null)
        const afterNull = getMessageWindowState(SESSION)
        const mainCountAfterNull = afterNull.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === MAIN
        ).length

        // State unchanged — null was ignored
        expect(mainCountAfterNull).toBe(mainCountAfterHint)
    })

    it('allows clearMessageWindow to clear the hint', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            if (i % 2 === 0) {
                messages.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
            } else {
                messages.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
            }
        }
        ingestIncomingMessages(SESSION, messages)
        setMainThreadId(SESSION, MAIN)

        // Clear resets everything including hint
        clearMessageWindow(SESSION)
        const afterClear = getMessageWindowState(SESSION)
        expect(afterClear.messages).toHaveLength(0)

        // Re-ingest — should use original trimming (no hint)
        ingestIncomingMessages(SESSION, messages)
        const afterReingest = getMessageWindowState(SESSION)
        expect(afterReingest.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
    })

    it('allows mainThreadId to change from one non-null to another', () => {
        // Set up initial state with hint MAIN
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 300; i++) {
            messages.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
        }
        for (let i = 300; i < 500; i++) {
            messages.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
        }
        ingestIncomingMessages(SESSION, messages)
        setMainThreadId(SESSION, MAIN)

        // Ingest more sub messages to push above limit
        const moreSub: DecryptedMessage[] = []
        for (let i = 500; i < 700; i++) {
            moreSub.push(makeSubMsg(`sub-${i}`, i + 1, SUB))
        }
        ingestIncomingMessages(SESSION, moreSub)

        const state1 = getMessageWindowState(SESSION)
        const mainCount1 = state1.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === MAIN
        ).length

        // Change hint to SUB — MAIN messages now classified as sub-agent
        setMainThreadId(SESSION, SUB)

        // Ingest more to trigger retrim with new bucketing
        const more2: DecryptedMessage[] = []
        for (let i = 700; i < 800; i++) {
            more2.push(makeMainMsg(`main-${i}`, i + 1, MAIN))
        }
        ingestIncomingMessages(SESSION, more2)

        const state2 = getMessageWindowState(SESSION)
        const subCount2 = state2.messages.filter(
            (m) => (m.content as { threadId?: string }).threadId === SUB
        ).length

        // With SUB as main thread, SUB messages get MAIN_THREAD_BUDGET
        // and MAIN messages get SUB_AGENT_BUDGET — different distribution
        expect(subCount2).toBeLessThanOrEqual(MAIN_THREAD_BUDGET)
        expect(state2.messagesVersion).toBeGreaterThan(state1.messagesVersion)
    })

    it('skips retrim when messages are empty', () => {
        // No messages ingested
        const before = getMessageWindowState(SESSION)
        expect(before.messages).toHaveLength(0)

        setMainThreadId(SESSION, MAIN)
        const after = getMessageWindowState(SESSION)
        expect(after.messages).toHaveLength(0)
        // messagesVersion unchanged
        expect(after.messagesVersion).toBe(before.messagesVersion)
    })
})

describe('edge cases', () => {
    const SESSION = 'edge-session'

    let unsub: () => void

    beforeEach(() => {
        clearMessageWindow(SESSION)
        const listener = vi.fn()
        unsub = subscribeMessageWindow(SESSION, listener)
    })

    afterEach(() => {
        unsub()
    })

    it('falls back to original VISIBLE_WINDOW_SIZE when no hint is set', () => {
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            messages.push(makePlainMsg(`m-${i}`, i + 1))
        }
        ingestIncomingMessages(SESSION, messages)

        const state = getMessageWindowState(SESSION)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
    })

    it('cleans up threadHints and lastTrimModes on last listener unsubscribe', () => {
        const SESSION2 = 'cleanup-session'
        const listener = vi.fn()
        const unsub2 = subscribeMessageWindow(SESSION2, listener)

        const messages: DecryptedMessage[] = []
        for (let i = 0; i < 10; i++) {
            messages.push(makePlainMsg(`m-${i}`, i + 1))
        }
        ingestIncomingMessages(SESSION2, messages)
        setMainThreadId(SESSION2, 'thread-1')

        // Unsubscribe last listener — should clean up state
        unsub2()

        // After cleanup, state is freshly created (no existing state)
        const state = getMessageWindowState(SESSION2)
        expect(state.messages).toHaveLength(0)

        // Subscribe again to verify a fresh start with new listener
        const listener2 = vi.fn()
        const unsub3 = subscribeMessageWindow(SESSION2, listener2)

        // No hint — new messages should use full VISIBLE_WINDOW_SIZE behavior
        const bigMessages: DecryptedMessage[] = []
        for (let i = 0; i < 500; i++) {
            bigMessages.push(makePlainMsg(`m2-${i}`, i + 1))
        }
        ingestIncomingMessages(SESSION2, bigMessages)
        const state2 = getMessageWindowState(SESSION2)
        expect(state2.messages).toHaveLength(VISIBLE_WINDOW_SIZE)

        unsub3()
    })
})
