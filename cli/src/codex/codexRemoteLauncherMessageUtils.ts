export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : null;
}

export function normalizeCommand(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (Array.isArray(value)) {
        const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
        return joined.length > 0 ? joined : undefined;
    }
    return undefined;
}

export function formatOutputPreview(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
