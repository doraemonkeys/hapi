import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { buildThreadRegistry, type ThreadRegistry } from '@/chat/threadRegistry'
import { isObject } from '@hapi/protocol'

type ThreadFilterOptions = {
    allowedMainThreadIds?: ReadonlySet<string>
}

function getBlockThreadId(block: ChatBlock): string | undefined {
    if (block.kind === 'tool-call') {
        return block.threadId ?? block.tool.threadId
    }
    return block.threadId
}

function getReceiverThreadIds(value: unknown): string[] {
    if (!isObject(value)) return []

    const candidates = value.receiverThreadIds ?? value.receiver_thread_ids
    if (!Array.isArray(candidates)) return []
    return candidates.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function resolveSubAgentThreadId(block: ToolCallBlock, registry: ThreadRegistry): string | null {
    const mapped = registry.spawnCallIdToThreadId.get(block.tool.id)
    if (mapped) return mapped

    const receiverThreadIds = getReceiverThreadIds(block.tool.result)
    return receiverThreadIds[0] ?? null
}

function countToolOperationsByThread(blocks: ChatBlock[]): Map<string, number> {
    const counts = new Map<string, number>()
    const stack: ChatBlock[] = [...blocks]

    while (stack.length > 0) {
        const block = stack.pop()
        if (!block) continue

        if (block.kind === 'tool-call') {
            const threadId = getBlockThreadId(block)
            if (threadId) {
                counts.set(threadId, (counts.get(threadId) ?? 0) + 1)
            }

            if (block.children.length > 0) {
                stack.push(...block.children)
            }
        }
    }

    return counts
}

function filterBlockByMainThread(
    block: ChatBlock,
    registry: ThreadRegistry,
    operationCounts: Map<string, number>,
    allowedMainThreadIds: ReadonlySet<string>
): ChatBlock | null {
    const mainThreadId = registry.mainThreadId
    if (!mainThreadId) return block

    const threadId = getBlockThreadId(block)
    if (threadId && !allowedMainThreadIds.has(threadId)) {
        return null
    }

    if (block.kind !== 'tool-call') {
        return block
    }

    const children = filterChildren(block.children, registry, operationCounts, allowedMainThreadIds)
    let nextBlock: ToolCallBlock = children === block.children ? block : { ...block, children }

    if (block.tool.name === 'CodexSubAgent') {
        const subAgentThreadId = resolveSubAgentThreadId(block, registry)
        const subAgentOperationCount = subAgentThreadId ? (operationCounts.get(subAgentThreadId) ?? 0) : 0
        if (nextBlock.subAgentOperationCount !== subAgentOperationCount) {
            nextBlock = { ...nextBlock, subAgentOperationCount }
        }
    }

    return nextBlock
}

function filterChildren(
    children: ChatBlock[],
    registry: ThreadRegistry,
    operationCounts: Map<string, number>,
    allowedMainThreadIds: ReadonlySet<string>
): ChatBlock[] {
    let changed = false
    const filtered: ChatBlock[] = []

    for (const child of children) {
        const next = filterBlockByMainThread(child, registry, operationCounts, allowedMainThreadIds)
        if (!next) {
            changed = true
            continue
        }
        if (next !== child) {
            changed = true
        }
        filtered.push(next)
    }

    return changed ? filtered : children
}

export function filterBlocksByMainThread(
    blocks: ChatBlock[],
    registry: ThreadRegistry,
    options?: ThreadFilterOptions
): ChatBlock[] {
    if (!registry.mainThreadId) {
        // Fail-closed: if any block has a threadId, threads exist but main is unknown.
        // Suppress thread-scoped blocks to prevent sub-agent content leak.
        const hasThreadedBlocks = blocks.some((block) => getBlockThreadId(block) !== undefined)
        if (!hasThreadedBlocks) return blocks

        const filtered = blocks.filter((block) => getBlockThreadId(block) === undefined)
        return filtered.length === blocks.length ? blocks : filtered
    }

    const allowedMainThreadIds = options?.allowedMainThreadIds
        ? new Set(options.allowedMainThreadIds)
        : new Set<string>([registry.mainThreadId])
    allowedMainThreadIds.add(registry.mainThreadId)

    const operationCounts = countToolOperationsByThread(blocks)
    const filtered: ChatBlock[] = []
    let changed = false

    for (const block of blocks) {
        const next = filterBlockByMainThread(block, registry, operationCounts, allowedMainThreadIds)
        if (!next) {
            changed = true
            continue
        }
        if (next !== block) {
            changed = true
        }
        filtered.push(next)
    }

    return changed ? filtered : blocks
}

export function filterMainThreadBlocks(blocks: ChatBlock[], messages: NormalizedMessage[]): ChatBlock[] {
    return filterBlocksByMainThread(blocks, buildThreadRegistry(messages))
}
