import { z } from 'zod'
import { asString, isObject } from './utils'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

const AgentOutputDataSchema = z.object({
    uuid: z.string(),
    type: z.enum(['assistant', 'user', 'summary']),
    message: z.object({ id: z.string().optional() }).passthrough().optional()
}).passthrough()

const AgentOutputContentSchema = z.object({
    type: z.literal('output'),
    data: AgentOutputDataSchema
}).passthrough()

export function extractAgentOutputData(messageContent: unknown): {
    uuid: string
    messageId?: string
    sessionId?: string
} | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'agent') {
        return null
    }

    if (!isObject(record.content)) {
        return null
    }

    if (record.content.type === 'output') {
        const parsed = AgentOutputContentSchema.safeParse(record.content)
        if (!parsed.success) {
            return null
        }
        if (parsed.data.data.type !== 'assistant') {
            return null
        }

        const sessionId = typeof parsed.data.data.sessionId === 'string'
            ? parsed.data.data.sessionId
            : typeof parsed.data.data.session_id === 'string'
                ? parsed.data.data.session_id
                : undefined

        return {
            uuid: parsed.data.data.uuid,
            messageId: parsed.data.data.message?.id,
            sessionId
        }
    }

    if (record.content.type === 'codex') {
        const data = isObject(record.content.data) ? record.content.data : null
        if (!data) return null

        const id = asString(data.id ?? data.uuid)
        const turnId = asString(data.turnId ?? data.turn_id) ?? undefined
        const sessionId = asString(data.thread_id ?? data.threadId) ?? undefined

        if (!id || !turnId) return null

        // Codex fork anchors are turn-based. Persist turnId as messageId.
        return {
            uuid: id,
            messageId: turnId,
            sessionId
        }
    }

    return null
}

export function extractMessageThreadId(content: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (!record || record.role !== 'agent') return null
    const recordContent = record.content
    if (!isObject(recordContent) || recordContent.type !== 'codex') return null
    const data = isObject(recordContent.data) ? recordContent.data : null
    if (!data) return null
    return asString(data.thread_id ?? data.threadId)
}

export type { RoleWrappedRecord }
