export type ConvertedEvent = {
    type: string;
    [key: string]: unknown;
};

export const CODEX_EVENT_PREFIX = 'codex/event/';

export const REDUNDANT_CODEX_EVENT_SUFFIXES = new Set([
    'agent_message_delta',
    'agent_message_content_delta',
    'agent_message',
    'agent_reasoning_delta',
    'reasoning_content_delta',
    'agent_reasoning',
    'agent_reasoning_section_break',
    'exec_command_output_delta',
    'exec_command_begin',
    'exec_command_end',
    'item_started',
    'item_completed',
    'task_started',
    'task_complete',
    'token_count',
    'user_message',
    'turn_diff',
    'patch_apply_begin',
    'patch_apply_end',
    'deprecation_notice'
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : null;
}

export function extractItemId(params: Record<string, unknown>): string | null {
    const direct = asString(params.itemId ?? params.item_id ?? params.id);
    if (direct) return direct;

    const item = asRecord(params.item);
    if (item) {
        return asString(item.id ?? item.itemId ?? item.item_id);
    }

    return null;
}

export function extractItem(params: Record<string, unknown>): Record<string, unknown> | null {
    const item = asRecord(params.item);
    return item ?? params;
}

export function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;
    return raw.toLowerCase().replace(/[\s_-]/g, '');
}

export function extractCommand(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const parts = value.filter((part): part is string => typeof part === 'string');
        return parts.length > 0 ? parts.join(' ') : null;
    }
    return null;
}

export function extractChanges(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (record) return record;

    if (Array.isArray(value)) {
        const changes: Record<string, unknown> = {};
        for (const entry of value) {
            const entryRecord = asRecord(entry);
            if (!entryRecord) continue;
            const path = asString(entryRecord.path ?? entryRecord.file ?? entryRecord.filePath ?? entryRecord.file_path);
            if (path) {
                changes[path] = entryRecord;
            }
        }
        return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
}

export function extractCodexMessage(params: Record<string, unknown>): Record<string, unknown> {
    const messageRecord = asRecord(params.msg ?? params.message);
    if (messageRecord) return messageRecord;

    const msgText = asString(params.msg);
    if (!msgText) return {};

    try {
        const parsed = JSON.parse(msgText);
        return asRecord(parsed) ?? {};
    } catch {
        return {};
    }
}
