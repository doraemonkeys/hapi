import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { extractMessageThreadId } from '@hapi/protocol/messages'

import type { StoredMessage } from './types'
import { safeJsonParse } from './json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
    thread_id: string | null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        threadId: row.thread_id
    }
}

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    threadId?: string
): StoredMessage {
    const now = Date.now()
    const id = randomUUID()
    const json = JSON.stringify(content)
    const tid = threadId ?? extractMessageThreadId(content)

    // Fast path: localId already exists → idempotent return.
    // Intentionally outside transaction: avoids opening a transaction for duplicate messages.
    // bun:sqlite synchronous API + JS single-thread = no async gap between fast path and write path, no race risk.
    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    // Write path: transaction protects seq allocation + INSERT
    try {
        db.exec('BEGIN')

        const msgSeqRow = db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }

        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, thread_id
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @thread_id
            )
        `).run({
            id,
            session_id: sessionId,
            content: json,
            created_at: now,
            seq: msgSeqRow.nextSeq,
            local_id: localId ?? null,
            thread_id: tid
        })

        db.exec('COMMIT')
    } catch (error) {
        db.exec('ROLLBACK')

        // localId UNIQUE constraint collision → idempotent return
        if (localId && error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
            const existing = db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
            ).get(sessionId, localId) as DbMessageRow | undefined
            if (existing) {
                return toStoredMessage(existing)
            }
        }
        throw error
    }

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to create message')
    }
    return toStoredMessage(row)
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number,
    threadId?: string
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const hasBeforeSeq = beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq)

    if (threadId) {
        const rows = hasBeforeSeq
            ? db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND (thread_id = ? OR thread_id IS NULL) AND seq < ? ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, threadId, beforeSeq, safeLimit) as DbMessageRow[]
            : db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND (thread_id = ? OR thread_id IS NULL) ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, threadId, safeLimit) as DbMessageRow[]
        return rows.reverse().map(toStoredMessage)
    }

    const rows = hasBeforeSeq
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
        : db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    try {
        db.exec('BEGIN')

        const oldMaxSeq = getMaxSeq(db, fromSessionId)
        const newMaxSeq = getMaxSeq(db, toSessionId)

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            db.prepare(
                `UPDATE messages SET local_id = NULL WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

export function getFirstMessages(
    db: Database,
    sessionId: string,
    limit: number = 10
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 10
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export function copyMessagesUpTo(
    db: Database,
    fromSessionId: string,
    toSessionId: string,
    maxSeq: number
): number {
    if (fromSessionId === toSessionId) {
        return 0
    }

    const safeMaxSeq = Number.isFinite(maxSeq) ? Math.floor(maxSeq) : 0
    if (safeMaxSeq <= 0) {
        return 0
    }

    try {
        db.exec('BEGIN')

        const rows = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq ASC'
        ).all(fromSessionId, safeMaxSeq) as DbMessageRow[]
        if (rows.length === 0) {
            db.exec('COMMIT')
            return 0
        }

        db.prepare(
            'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
        ).run(rows.length, toSessionId)

        const insertStatement = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, thread_id
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @thread_id
            )
        `)

        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]
            insertStatement.run({
                id: randomUUID(),
                session_id: toSessionId,
                content: row.content,
                created_at: row.created_at,
                seq: index + 1,
                local_id: null,
                thread_id: row.thread_id
            })
        }

        db.exec('COMMIT')
        return rows.length
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
