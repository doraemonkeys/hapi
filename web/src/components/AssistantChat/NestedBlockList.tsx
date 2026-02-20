import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { safeStringify } from '@hapi/protocol'
import { getEventPresentation } from '@/chat/presentation'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { CliOutputBlock } from '@/components/CliOutputBlock'

function isPendingPermissionBlock(block: ChatBlock): boolean {
    return block.kind === 'tool-call' && block.tool.permission?.status === 'pending'
}

function formatPlainValue(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    return safeStringify(value)
}

export function splitTaskChildren(block: ToolCallBlock): { pending: ChatBlock[]; rest: ChatBlock[] } {
    const pending: ChatBlock[] = []
    const rest: ChatBlock[] = []

    for (const child of block.children) {
        if (isPendingPermissionBlock(child)) {
            pending.push(child)
        } else {
            rest.push(child)
        }
    }

    return { pending, rest }
}

export function HappyNestedBlockList(props: {
    blocks: ChatBlock[]
    usePlainText?: boolean
}) {
    const ctx = useHappyChatContext()
    const usePlainText = props.usePlainText === true

    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    const userBubbleClass = 'w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'
                    const status = block.status
                    const canRetry = status === 'failed' && typeof block.localId === 'string' && Boolean(ctx.onRetryMessage)
                    const onRetry = canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined

                    return (
                        <div key={`user:${block.id}`} className={userBubbleClass}>
                            <div className="flex items-end gap-2">
                                <div className="flex-1">
                                    {usePlainText ? (
                                        <div className="whitespace-pre-wrap break-words text-sm">
                                            {block.text}
                                        </div>
                                    ) : (
                                        <LazyRainbowText text={block.text} />
                                    )}
                                </div>
                                {status ? (
                                    <div className="shrink-0 self-end pb-0.5">
                                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-text') {
                    return (
                        <div key={`agent:${block.id}`} className="px-1">
                            {usePlainText ? (
                                <div className="whitespace-pre-wrap break-words text-sm">
                                    {block.text}
                                </div>
                            ) : (
                                <MarkdownRenderer content={block.text} />
                            )}
                        </div>
                    )
                }

                if (block.kind === 'agent-reasoning') {
                    return (
                        <details key={`reasoning:${block.id}`} className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2">
                            <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                Thinking
                            </summary>
                            <div className="mt-2 px-1">
                                {usePlainText ? (
                                    <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">
                                        {block.text}
                                    </div>
                                ) : (
                                    <MarkdownRenderer content={block.text} />
                                )}
                            </div>
                        </details>
                    )
                }

                if (block.kind === 'cli-output') {
                    const alignClass = block.source === 'user' ? 'ml-auto w-full max-w-[92%]' : ''
                    return (
                        <div key={`cli:${block.id}`} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                            <div className={alignClass}>
                                <CliOutputBlock text={block.text} />
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-event') {
                    const presentation = getEventPresentation(block.event)
                    return (
                        <div key={`event:${block.id}`} className="py-1">
                            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                                <span className="inline-flex items-center gap-1">
                                    {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
                                    <span>{presentation.text}</span>
                                </span>
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'tool-call') {
                    const isTask = block.tool.name === 'Task'
                    const taskChildren = isTask ? splitTaskChildren(block) : null

                    if (usePlainText) {
                        const inputText = formatPlainValue(block.tool.input)
                        const resultText = formatPlainValue(block.tool.result)
                        return (
                            <div key={`tool:${block.id}`} className="py-1">
                                <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-sm font-medium break-all">{block.tool.name}</div>
                                        <div className="text-xs text-[var(--app-hint)]">{block.tool.state}</div>
                                    </div>
                                    {block.tool.description ? (
                                        <div className="mt-1 text-xs text-[var(--app-hint)] break-all">
                                            {block.tool.description}
                                        </div>
                                    ) : null}
                                    {inputText ? (
                                        <details className="mt-2">
                                            <summary className="cursor-pointer text-xs text-[var(--app-hint)]">Input</summary>
                                            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{inputText}</pre>
                                        </details>
                                    ) : null}
                                    {resultText ? (
                                        <details className="mt-2">
                                            <summary className="cursor-pointer text-xs text-[var(--app-hint)]">Result</summary>
                                            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{resultText}</pre>
                                        </details>
                                    ) : null}
                                </div>
                                {block.children.length > 0 ? (
                                    <div className="mt-2 pl-3">
                                        <HappyNestedBlockList blocks={block.children} usePlainText />
                                    </div>
                                ) : null}
                            </div>
                        )
                    }

                    return (
                        <div key={`tool:${block.id}`} className="py-1">
                            <ToolCard
                                api={ctx.api}
                                sessionId={ctx.sessionId}
                                metadata={ctx.metadata}
                                disabled={ctx.disabled}
                                onDone={ctx.onRefresh}
                                block={block}
                            />
                            {block.children.length > 0 ? (
                                isTask ? (
                                    <>
                                        {taskChildren && taskChildren.pending.length > 0 ? (
                                            <div className="mt-2 pl-3">
                                                <HappyNestedBlockList blocks={taskChildren.pending} usePlainText={usePlainText} />
                                            </div>
                                        ) : null}
                                        {taskChildren && taskChildren.rest.length > 0 ? (
                                            <details className="mt-2">
                                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                                    Task details ({taskChildren.rest.length})
                                                </summary>
                                                <div className="mt-2 pl-3">
                                                    <HappyNestedBlockList blocks={taskChildren.rest} usePlainText={usePlainText} />
                                                </div>
                                            </details>
                                        ) : null}
                                    </>
                                ) : (
                                    <div className="mt-2 pl-3">
                                        <HappyNestedBlockList blocks={block.children} usePlainText={usePlainText} />
                                    </div>
                                )
                            ) : null}
                        </div>
                    )
                }

                return null
            })}
        </div>
    )
}
