import type { NormalizedMessage, ToolResult } from '@/chat/types'
import { asString, isObject } from '@hapi/protocol'

type MainThreadSignal = 'seed' | 'sender' | 'thread_started_main' | 'fallback'

const MAIN_THREAD_SIGNAL_PRIORITY: Record<MainThreadSignal, number> = {
    // Seed comes from session metadata (codexSessionId) and represents the
    // canonical active thread for this HAPI session. Historical replay can
    // include sender hints from earlier source threads (e.g. fork ancestry),
    // so seed must not be downgraded by message-derived signals.
    seed: 4,
    sender: 3,
    thread_started_main: 2,
    fallback: 1
}

export type ThreadRegistry = {
    mainThreadId: string | null
    mainThreadSignal: MainThreadSignal | null
    subAgentThreadIds: Set<string>
    spawnCallIdToThreadId: Map<string, string>
}

export type ThreadRegistryAccumulator = {
    registry: ThreadRegistry
    messages: NormalizedMessage[]
    seed: string | null
}

export function createThreadRegistry(): ThreadRegistry {
    return {
        mainThreadId: null,
        mainThreadSignal: null,
        subAgentThreadIds: new Set<string>(),
        spawnCallIdToThreadId: new Map<string, string>()
    }
}

export function createThreadRegistryAccumulator(seed?: string | null): ThreadRegistryAccumulator {
    const registry = createThreadRegistry()
    if (seed) {
        registry.mainThreadId = seed
        registry.mainThreadSignal = 'seed'
    }
    return {
        registry,
        messages: [],
        seed: seed ?? null
    }
}

function getThreadStartedFromEvent(message: NormalizedMessage): { threadId: string; isMain: boolean | null } | null {
    if (message.role !== 'event' || message.content.type !== 'thread_started') return null

    const event = message.content as Record<string, unknown>
    const threadId = asString(event.threadId ?? event.thread_id)
    if (!threadId) return null

    const isMainRaw = event.isMain ?? event.is_main
    const isMain = typeof isMainRaw === 'boolean' ? isMainRaw : null
    return { threadId, isMain }
}

function extractSenderThreadId(message: NormalizedMessage): string | null {
    if (message.role === 'event' && message.content.type === 'collab_agent_spawn') {
        const event = message.content as Record<string, unknown>
        return asString(event.sender_thread_id ?? event.senderThreadId)
    }

    if (message.role !== 'agent') return null
    for (const content of message.content) {
        if (content.type !== 'tool-call' || content.name !== 'CodexSubAgent') continue
        if (!isObject(content.input)) continue
        const senderThreadId = asString(content.input.sender_thread_id ?? content.input.senderThreadId)
        if (senderThreadId) return senderThreadId
    }
    return null
}

function extractReceiverThreadIds(content: ToolResult): string[] {
    if (content.receiverThreadIds && content.receiverThreadIds.length > 0) {
        return content.receiverThreadIds
    }
    if (!isObject(content.content)) return []

    const raw = content.content.receiverThreadIds ?? content.content.receiver_thread_ids
    if (!Array.isArray(raw)) return []
    return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function collectMessageThreadIds(message: NormalizedMessage): string[] {
    const ids = new Set<string>()

    if (message.threadId) {
        ids.add(message.threadId)
    }

    const threadStarted = getThreadStartedFromEvent(message)
    if (threadStarted) {
        ids.add(threadStarted.threadId)
    }

    if (message.role === 'agent') {
        for (const content of message.content) {
            if ('threadId' in content && typeof content.threadId === 'string' && content.threadId.length > 0) {
                ids.add(content.threadId)
            }
        }
    }

    return [...ids]
}

export function updateRegistry(prev: ThreadRegistry, message: NormalizedMessage): ThreadRegistry {
    let didChange = false
    let mainThreadId = prev.mainThreadId
    let mainThreadSignal = prev.mainThreadSignal
    let subAgentThreadIds = prev.subAgentThreadIds
    let spawnCallIdToThreadId = prev.spawnCallIdToThreadId

    const ensureSubAgentSet = (): void => {
        if (subAgentThreadIds === prev.subAgentThreadIds) {
            subAgentThreadIds = new Set(subAgentThreadIds)
        }
    }

    const updateMainThread = (candidate: string | null, source: MainThreadSignal): void => {
        if (!candidate) return

        const currentPriority = mainThreadSignal ? MAIN_THREAD_SIGNAL_PRIORITY[mainThreadSignal] : 0
        const nextPriority = MAIN_THREAD_SIGNAL_PRIORITY[source]
        const shouldUpgrade = !mainThreadId || nextPriority > currentPriority
        if (!shouldUpgrade) return

        const previousMainThreadId = mainThreadId
        const previousSignal = mainThreadSignal
        mainThreadId = candidate
        mainThreadSignal = source

        if (previousMainThreadId !== candidate || previousSignal !== source) {
            didChange = true
        }

        if (!previousMainThreadId && source === 'fallback') {
            console.warn('[threadRegistry] Falling back to first thread_started event for main thread detection')
        }

        if (previousMainThreadId && previousMainThreadId !== candidate) {
            ensureSubAgentSet()
            if (!subAgentThreadIds.has(previousMainThreadId)) {
                subAgentThreadIds.add(previousMainThreadId)
                didChange = true
            }
        }

        if (subAgentThreadIds.has(candidate)) {
            ensureSubAgentSet()
            if (subAgentThreadIds.delete(candidate)) {
                didChange = true
            }
        }
    }

    updateMainThread(extractSenderThreadId(message), 'sender')

    const threadStarted = getThreadStartedFromEvent(message)
    if (threadStarted?.isMain === true) {
        updateMainThread(threadStarted.threadId, 'thread_started_main')
    } else if (threadStarted?.threadId) {
        updateMainThread(threadStarted.threadId, 'fallback')
    }

    if (message.role === 'agent') {
        for (const content of message.content) {
            if (content.type !== 'tool-result') continue
            const receiverThreadIds = extractReceiverThreadIds(content)
            if (receiverThreadIds.length === 0) continue

            const mappedThreadId = receiverThreadIds[0]
            if (spawnCallIdToThreadId.get(content.tool_use_id) !== mappedThreadId) {
                if (spawnCallIdToThreadId === prev.spawnCallIdToThreadId) {
                    spawnCallIdToThreadId = new Map(spawnCallIdToThreadId)
                }
                spawnCallIdToThreadId.set(content.tool_use_id, mappedThreadId)
                didChange = true
            }

            for (const threadId of receiverThreadIds) {
                if (threadId === mainThreadId) continue
                if (subAgentThreadIds.has(threadId)) continue
                ensureSubAgentSet()
                subAgentThreadIds.add(threadId)
                didChange = true
            }
        }
    }

    if (mainThreadId) {
        const seenThreadIds = collectMessageThreadIds(message)
        for (const threadId of seenThreadIds) {
            if (threadId === mainThreadId || subAgentThreadIds.has(threadId)) continue
            ensureSubAgentSet()
            subAgentThreadIds.add(threadId)
            didChange = true
        }
    }

    if (!didChange) {
        return prev
    }

    return {
        mainThreadId,
        mainThreadSignal,
        subAgentThreadIds,
        spawnCallIdToThreadId
    }
}

export function buildThreadRegistry(messages: NormalizedMessage[]): ThreadRegistry {
    return messages.reduce((registry, message) => updateRegistry(registry, message), createThreadRegistry())
}

export function accumulateThreadRegistry(
    prev: ThreadRegistryAccumulator,
    messages: NormalizedMessage[]
): ThreadRegistryAccumulator {
    if (prev.messages === messages) {
        return prev
    }

    let registry = prev.registry
    let startIndex = 0

    const createSeededRegistry = (): ThreadRegistry => {
        const fresh = createThreadRegistry()
        if (prev.seed) {
            fresh.mainThreadId = prev.seed
            fresh.mainThreadSignal = 'seed'
        }
        return fresh
    }

    if (prev.messages.length <= messages.length) {
        startIndex = prev.messages.length
        for (let index = 0; index < prev.messages.length; index += 1) {
            if (prev.messages[index] === messages[index]) continue
            registry = createSeededRegistry()
            startIndex = 0
            break
        }
    } else {
        registry = createSeededRegistry()
    }

    for (let index = startIndex; index < messages.length; index += 1) {
        registry = updateRegistry(registry, messages[index]!)
    }

    return {
        registry,
        messages,
        seed: prev.seed
    }
}
