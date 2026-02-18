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

export interface ForkSessionOptions {
    sourceClaudeSessionId: string
    path: string
    forkAtUuid: string
    forkAtMessageId?: string
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode'
    model?: string
}

export type ForkSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorMessage: string }
