import type { ModelMode } from './modes'
import type { Session, WorktreeMetadata } from './schemas'

export type SessionSummaryMetadata = {
    name?: string
    titleHint?: string
    path: string
    machineId?: string
    summary?: { text: string }
    flavor?: string | null
    model?: string
    worktree?: WorktreeMetadata
}

export type SessionSummary = {
    id: string
    active: boolean
    thinking: boolean
    activeAt: number
    updatedAt: number
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    modelMode?: ModelMode
}

type DisplayTitleMetadata = {
    name?: string
    summary?: { text: string } | null
    titleHint?: string
    path?: string
}

export function getDisplayTitle(metadata: DisplayTitleMetadata | null | undefined, sessionId: string): string {
    if (metadata?.name) {
        return metadata.name
    }

    if (metadata?.summary?.text) {
        return metadata.summary.text
    }

    if (metadata?.titleHint) {
        return metadata.titleHint
    }

    if (metadata?.path) {
        const pathSegments = metadata.path.split(/[\\/]+/).filter(Boolean)
        if (pathSegments.length > 0) {
            return pathSegments[pathSegments.length - 1]!
        }
    }

    return sessionId.slice(0, 8)
}

export function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        titleHint: session.metadata.titleHint,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        model: session.metadata.model,
        worktree: session.metadata.worktree
    } : null

    const todoProgress = session.todos?.length ? {
        completed: session.todos.filter(t => t.status === 'completed').length,
        total: session.todos.length
    } : null

    return {
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        metadata,
        todoProgress,
        pendingRequestsCount,
        modelMode: session.modelMode
    }
}
