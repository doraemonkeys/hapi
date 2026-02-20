import { useCallback, useMemo } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyNestedBlockList } from '@/components/AssistantChat/NestedBlockList'
import { LoadingState } from '@/components/LoadingState'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSession } from '@/hooks/queries/useSession'
import { useAppContext } from '@/lib/app-context'

function BackIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getBlockThreadId(block: ChatBlock): string | null {
    return asString((block as ChatBlock & { threadId?: unknown }).threadId)
}

function filterBlocksByThreadId(blocks: ChatBlock[], threadId: string): ChatBlock[] {
    const filtered: ChatBlock[] = []

    for (const block of blocks) {
        const blockThreadId = getBlockThreadId(block)
        if (block.kind !== 'tool-call') {
            if (blockThreadId === threadId) {
                filtered.push(block)
            }
            continue
        }

        const children = filterBlocksByThreadId(block.children, threadId)
        if (blockThreadId !== threadId && children.length === 0) {
            continue
        }

        if (children.length === block.children.length) {
            filtered.push(block)
            continue
        }

        filtered.push({
            ...block,
            children
        } satisfies ToolCallBlock)
    }

    return filtered
}

function flattenBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const flattened: ChatBlock[] = []
    for (const block of blocks) {
        flattened.push(block)
        if (block.kind === 'tool-call' && block.children.length > 0) {
            flattened.push(...flattenBlocks(block.children))
        }
    }
    return flattened
}

function countToolOperations(blocks: ChatBlock[]): number {
    let count = 0
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            count += 1
            count += countToolOperations(block.children)
        }
    }
    return count
}

export default function SubAgentPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { sessionId, threadId } = useParams({ from: '/sessions/$sessionId/thread/$threadId' })
    const { session, refetch: refetchSession } = useSession(api, sessionId)
    const { messages, warning, isLoading, refetch } = useMessages(api, sessionId)

    const normalizedMessages = useMemo(() => {
        const normalized = messages
            .map((message) => normalizeDecryptedMessage(message))
            .filter((message): message is NonNullable<typeof message> => message !== null)
        return normalized
    }, [messages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, session?.agentState),
        [normalizedMessages, session?.agentState]
    )

    const filteredBlocks = useMemo(
        () => filterBlocksByThreadId(reduced.blocks, threadId),
        [reduced.blocks, threadId]
    )

    const flattenedBlocks = useMemo(
        () => flattenBlocks(filteredBlocks),
        [filteredBlocks]
    )

    const operationCount = useMemo(
        () => countToolOperations(filteredBlocks),
        [filteredBlocks]
    )

    const spawnPrompt = useMemo(() => {
        const firstUserBlock = flattenedBlocks.find((block) => block.kind === 'user-text')
        return firstUserBlock?.kind === 'user-text' ? firstUserBlock.text : null
    }, [flattenedBlocks])

    const handleBack = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId }
        })
    }, [navigate, sessionId])

    const handleRefresh = useCallback(() => {
        void refetchSession()
        void refetch()
    }, [refetch, refetchSession])

    if (!session || isLoading) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading thread…" className="text-sm" />
            </div>
        )
    }

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <button
                        type="button"
                        onClick={handleBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Sub-agent thread</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">
                            {operationCount} tool operations
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content p-3">
                    {spawnPrompt ? (
                        <div className="mb-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                            <div className="text-xs text-[var(--app-hint)] mb-1">Spawn prompt</div>
                            <div className="text-sm">{spawnPrompt}</div>
                        </div>
                    ) : null}

                    {warning ? (
                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                            {warning}
                        </div>
                    ) : null}

                    <HappyChatProvider
                        value={{
                            api,
                            sessionId,
                            metadata: session.metadata,
                            disabled: true,
                            isForkingFromMessage: false,
                            onRefresh: handleRefresh
                        }}
                    >
                        {filteredBlocks.length > 0 ? (
                            <HappyNestedBlockList blocks={filteredBlocks} usePlainText />
                        ) : (
                            <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                                No thread blocks found for {threadId}.
                            </div>
                        )}
                    </HappyChatProvider>
                </div>
            </div>
        </div>
    )
}
