import { useCallback } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { ForkIcon } from '@/components/icons'
import { Spinner } from '@/components/Spinner'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const ctx = useHappyChatContext()
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const forkSeq = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.seq
    })
    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'px-1 min-w-0 max-w-full overflow-x-hidden'
    const canFork = typeof forkSeq === 'number' && Number.isFinite(forkSeq) && forkSeq > 0 && Boolean(ctx.onForkFromMessage)

    const handleFork = useCallback(() => {
        if (!canFork || ctx.isForkingFromMessage) {
            return
        }
        ctx.onForkFromMessage?.(forkSeq)
    }, [canFork, ctx, forkSeq])

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <CliOutputBlock text={cliText} />
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root className={`${rootClass} assistant-message-root`}>
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                </div>
                {canFork ? (
                    <div className="assistant-message-fork-action shrink-0 pt-0.5">
                        <button
                            type="button"
                            onClick={handleFork}
                            disabled={ctx.isForkingFromMessage}
                            title="Fork from here"
                            aria-label="Fork from here"
                            aria-busy={ctx.isForkingFromMessage}
                            className="rounded-md p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {ctx.isForkingFromMessage ? (
                                <Spinner size="sm" label={null} className="h-3.5 w-3.5 text-current" />
                            ) : (
                                <ForkIcon className="h-3.5 w-3.5" />
                            )}
                        </button>
                    </div>
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
