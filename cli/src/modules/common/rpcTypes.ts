export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode'
    model?: string
    yolo?: boolean
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }

interface ForkSessionBaseOptions {
    path: string
    model?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export interface ClaudeForkSessionOptions extends ForkSessionBaseOptions {
    agent: 'claude'
    sourceSessionId: string
    forkAtUuid: string
    forkAtMessageId?: string
}

export interface CodexForkSessionOptions extends ForkSessionBaseOptions {
    agent: 'codex'
    sourceThreadId: string
    forkAtTurnId: string
}

export type ForkSessionOptions = ClaudeForkSessionOptions | CodexForkSessionOptions

export interface ForkSessionRequestOptions {
    agent?: 'claude' | 'codex'
    path?: string
    model?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    sourceSessionId?: string
    sourceThreadId?: string
    forkAtUuid?: string
    forkAtMessageId?: string
    forkAtTurnId?: string
}

export type ForkSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorMessage: string }
