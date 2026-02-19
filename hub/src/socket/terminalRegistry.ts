export type TerminalRegistryEntry = {
    terminalId: string
    sessionId: string
    socketId: string
    cliSocketId: string
    idleTimer: ReturnType<typeof setTimeout> | null
    orphanedAt: number | null
    keepaliveTimer: ReturnType<typeof setTimeout> | null
    removedReason: TerminalRegistryRemovalReason | null
}

export type TerminalRegistryRemovalReason = 'expired' | 'cli_disconnected'

type TerminalRegistryOptions = {
    idleTimeoutMs: number
    keepaliveTimeoutMs?: number
    onIdle?: (entry: TerminalRegistryEntry) => void
    onOrphanExpired?: (entry: TerminalRegistryEntry) => void
}

export class TerminalRegistry {
    private readonly terminals = new Map<string, TerminalRegistryEntry>()
    private readonly terminalsBySocket = new Map<string, Set<string>>()
    private readonly terminalsBySession = new Map<string, Set<string>>()
    private readonly terminalsByCliSocket = new Map<string, Set<string>>()
    private readonly removedReasons = new Map<string, TerminalRegistryRemovalReason>()
    private readonly removedReasonTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly idleTimeoutMs: number
    private readonly keepaliveTimeoutMs: number
    private readonly onIdle?: (entry: TerminalRegistryEntry) => void
    private readonly onOrphanExpired?: (entry: TerminalRegistryEntry) => void

    constructor(options: TerminalRegistryOptions) {
        this.idleTimeoutMs = options.idleTimeoutMs
        this.keepaliveTimeoutMs = options.keepaliveTimeoutMs ?? 60_000
        this.onIdle = options.onIdle
        this.onOrphanExpired = options.onOrphanExpired
    }

    register(terminalId: string, sessionId: string, socketId: string, cliSocketId: string): TerminalRegistryEntry | null {
        if (this.terminals.has(terminalId)) {
            return null
        }

        const entry: TerminalRegistryEntry = {
            terminalId,
            sessionId,
            socketId,
            cliSocketId,
            idleTimer: null,
            orphanedAt: null,
            keepaliveTimer: null,
            removedReason: null
        }

        this.clearRemovedReason(terminalId)
        this.terminals.set(terminalId, entry)
        this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        this.addToIndex(this.terminalsBySession, sessionId, terminalId)
        this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId)
        this.scheduleIdle(entry)

        return entry
    }

    markActivity(terminalId: string): void {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return
        }
        this.scheduleIdle(entry)
    }

    get(terminalId: string): TerminalRegistryEntry | null {
        return this.terminals.get(terminalId) ?? null
    }

    remove(terminalId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return null
        }

        this.terminals.delete(terminalId)
        this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId)
        this.removeFromIndex(this.terminalsBySession, entry.sessionId, terminalId)
        this.removeFromIndex(this.terminalsByCliSocket, entry.cliSocketId, terminalId)
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
            entry.idleTimer = null
        }
        if (entry.keepaliveTimer) {
            clearTimeout(entry.keepaliveTimer)
            entry.keepaliveTimer = null
        }

        return entry
    }

    orphanBySocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        const orphanedAt = Date.now()
        const entries: TerminalRegistryEntry[] = []

        for (const terminalId of Array.from(ids)) {
            const entry = this.terminals.get(terminalId)
            if (!entry) {
                continue
            }

            this.removeFromIndex(this.terminalsBySocket, socketId, terminalId)
            entry.orphanedAt = orphanedAt

            if (entry.keepaliveTimer) {
                clearTimeout(entry.keepaliveTimer)
                entry.keepaliveTimer = null
            }

            if (this.keepaliveTimeoutMs <= 0) {
                this.markRemovedReason(terminalId, 'expired')
                const removed = this.remove(terminalId)
                if (removed) {
                    this.onOrphanExpired?.(removed)
                }
                continue
            }

            entry.keepaliveTimer = setTimeout(() => {
                const current = this.terminals.get(terminalId)
                if (!current || current.orphanedAt === null) {
                    return
                }

                this.markRemovedReason(terminalId, 'expired')
                const removed = this.remove(terminalId)
                if (removed) {
                    this.onOrphanExpired?.(removed)
                }
            }, this.keepaliveTimeoutMs)

            entries.push(entry)
        }

        return entries
    }

    removeByCliDisconnect(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsByCliSocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        const removed: TerminalRegistryEntry[] = []
        for (const terminalId of Array.from(ids)) {
            this.markRemovedReason(terminalId, 'cli_disconnected')
            const entry = this.remove(terminalId)
            if (entry) {
                removed.push(entry)
            }
        }
        return removed
    }

    attachToSocket(
        terminalId: string,
        sessionId: string,
        newSocketId: string
    ): { entry: TerminalRegistryEntry } | { error: 'cli_disconnected' | 'terminal_not_found' } {
        const entry = this.terminals.get(terminalId)
        if (!entry || entry.orphanedAt === null) {
            return {
                error: this.removedReasons.get(terminalId) === 'cli_disconnected' ? 'cli_disconnected' : 'terminal_not_found'
            }
        }
        if (entry.sessionId !== sessionId) {
            return { error: 'terminal_not_found' }
        }

        if (entry.keepaliveTimer) {
            clearTimeout(entry.keepaliveTimer)
            entry.keepaliveTimer = null
        }

        entry.socketId = newSocketId
        entry.orphanedAt = null
        entry.removedReason = null
        this.addToIndex(this.terminalsBySocket, newSocketId, terminalId)
        this.scheduleIdle(entry)
        this.clearRemovedReason(terminalId)

        return { entry }
    }

    countForSocket(socketId: string): number {
        return this.terminalsBySocket.get(socketId)?.size ?? 0
    }

    countForSession(sessionId: string): number {
        return this.terminalsBySession.get(sessionId)?.size ?? 0
    }

    private scheduleIdle(entry: TerminalRegistryEntry): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        entry.idleTimer = setTimeout(() => {
            const current = this.terminals.get(entry.terminalId)
            if (!current) {
                return
            }
            this.onIdle?.(current)
            this.remove(entry.terminalId)
        }, this.idleTimeoutMs)
    }

    private markRemovedReason(terminalId: string, reason: TerminalRegistryRemovalReason): void {
        const entry = this.terminals.get(terminalId)
        if (entry) {
            entry.removedReason = reason
        }
        this.removedReasons.set(terminalId, reason)
        const existingTimer = this.removedReasonTimers.get(terminalId)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.removedReasonTimers.delete(terminalId)
        }

        if (this.keepaliveTimeoutMs <= 0) {
            this.removedReasons.delete(terminalId)
            return
        }

        const timer = setTimeout(() => {
            this.removedReasons.delete(terminalId)
            this.removedReasonTimers.delete(terminalId)
        }, this.keepaliveTimeoutMs)
        this.removedReasonTimers.set(terminalId, timer)
    }

    private clearRemovedReason(terminalId: string): void {
        const entry = this.terminals.get(terminalId)
        if (entry) {
            entry.removedReason = null
        }
        this.removedReasons.delete(terminalId)
        const timer = this.removedReasonTimers.get(terminalId)
        if (!timer) {
            return
        }
        clearTimeout(timer)
        this.removedReasonTimers.delete(terminalId)
    }

    private addToIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (set) {
            set.add(terminalId)
        } else {
            index.set(key, new Set([terminalId]))
        }
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (!set) {
            return
        }
        set.delete(terminalId)
        if (set.size === 0) {
            index.delete(key)
        }
    }
}
