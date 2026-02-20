import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ToolCallBlock } from '@/chat/types'
import { isObject, safeStringify } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { HappyNestedBlockList, splitTaskChildren } from '@/components/AssistantChat/NestedBlockList'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'

function isToolCallBlock(value: unknown): value is ToolCallBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'tool-call') return false
    if (typeof value.id !== 'string') return false
    if (value.localId !== null && typeof value.localId !== 'string') return false
    if (typeof value.createdAt !== 'number') return false
    if (!Array.isArray(value.children)) return false
    if (!isObject(value.tool)) return false
    if (typeof value.tool.name !== 'string') return false
    if (!('input' in value.tool)) return false
    if (value.tool.description !== null && typeof value.tool.description !== 'string') return false
    if (value.tool.state !== 'pending' && value.tool.state !== 'running' && value.tool.state !== 'completed' && value.tool.state !== 'error') return false
    return true
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
    const ctx = useHappyChatContext()
    const artifact = props.artifact

    if (!isToolCallBlock(artifact)) {
        const argsText = typeof props.argsText === 'string' ? props.argsText.trim() : ''
        const hasArgsText = argsText.length > 0
        const hasResult = props.result !== undefined
        const resultText = hasResult ? safeStringify(props.result) : ''

        return (
            <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="rounded-xl bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                    <div className="flex items-center gap-2 text-xs">
                        <div className="font-mono text-[var(--app-hint)]">
                            Tool: {props.toolName}
                        </div>
                        {props.isError ? (
                            <span className="text-red-500">Error</span>
                        ) : null}
                        {props.status.type === 'running' && !hasResult ? (
                            <span className="text-[var(--app-hint)]">Running…</span>
                        ) : null}
                    </div>

                    {hasArgsText ? (
                        <div className="mt-2">
                            <CodeBlock code={argsText} language="json" />
                        </div>
                    ) : null}

                    {hasResult ? (
                        <div className="mt-2">
                            <CodeBlock code={resultText} language={typeof props.result === 'string' ? 'text' : 'json'} />
                        </div>
                    ) : null}
                </div>
            </div>
        )
    }

    const block = artifact
    const isTask = block.tool.name === 'Task'
    const taskChildren = isTask ? splitTaskChildren(block) : null

    return (
        <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
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
                                <HappyNestedBlockList blocks={taskChildren.pending} />
                            </div>
                        ) : null}
                        {taskChildren && taskChildren.rest.length > 0 ? (
                            <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                    Task details ({taskChildren.rest.length})
                                </summary>
                                <div className="mt-2 pl-3">
                                    <HappyNestedBlockList blocks={taskChildren.rest} />
                                </div>
                            </details>
                        ) : null}
                    </>
                ) : (
                    <div className="mt-2 pl-3">
                        <HappyNestedBlockList blocks={block.children} />
                    </div>
                )
            ) : null}
        </div>
    )
}
