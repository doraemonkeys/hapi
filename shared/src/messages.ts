import { z } from 'zod'
import { isObject } from './utils'

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

export type { RoleWrappedRecord }
