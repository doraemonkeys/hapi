import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import { addMessage, copyMessagesUpTo, getFirstMessages, getMessages, getMessagesAfter, mergeSessionMessages } from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string, threadId?: string): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, threadId)
    }

    getMessages(sessionId: string, limit: number = 200, beforeSeq?: number, threadId?: string): StoredMessage[] {
        return getMessages(this.db, sessionId, limit, beforeSeq, threadId)
    }

    getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200): StoredMessage[] {
        return getMessagesAfter(this.db, sessionId, afterSeq, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 10): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    copyMessagesUpTo(fromSessionId: string, toSessionId: string, maxSeq: number): number {
        return copyMessagesUpTo(this.db, fromSessionId, toSessionId, maxSeq)
    }
}
