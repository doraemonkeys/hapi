import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

type JsonObject = Record<string, unknown>;

const ACP_WINDOWS_SHELL_SETTINGS: JsonObject = {
    tools: {
        shell: {
            enableInteractiveShell: false
        }
    }
};

export type GeminiAcpSystemSettingsResult = {
    settingsPath?: string;
    cleanup: () => void;
};

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Arrays are replaced wholesale (not concatenated) — matches settings-override semantics.
function deepMergeJson(base: JsonObject, override: JsonObject): JsonObject {
    const merged: JsonObject = { ...base };

    for (const [key, value] of Object.entries(override)) {
        const current = merged[key];
        if (isJsonObject(current) && isJsonObject(value)) {
            merged[key] = deepMergeJson(current, value);
            continue;
        }
        merged[key] = value;
    }

    return merged;
}

function readSettings(settingsPath?: string): JsonObject {
    if (!settingsPath || !existsSync(settingsPath)) {
        return {};
    }

    try {
        const raw = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (isJsonObject(parsed)) {
            return parsed;
        }
        logger.debug(`[gemini-settings] Ignoring non-object settings from ${settingsPath}`);
    } catch (error) {
        logger.debug(`[gemini-settings] Failed to read settings from ${settingsPath}: ${error}`);
    }

    return {};
}

function createCleanup(settingsPath: string): () => void {
    return () => {
        try {
            if (existsSync(settingsPath)) {
                unlinkSync(settingsPath);
            }
        } catch (error) {
            logger.debug(`[gemini-settings] Failed to cleanup temporary settings ${settingsPath}: ${error}`);
        }
    };
}

/** Merges Windows-specific `enableInteractiveShell: false` into base settings.
 *  Platform gating is the caller's responsibility. */
export function applyWindowsShellOverride(baseSettings: JsonObject): JsonObject {
    return deepMergeJson(baseSettings, ACP_WINDOWS_SHELL_SETTINGS);
}

export function prepareGeminiAcpSystemSettings(opts: {
    baseSettingsPath?: string;
    platform?: NodeJS.Platform;
    outputDir?: string;
    now?: () => number;
    random?: () => number;
    _mkdirSync?: typeof mkdirSync;
    _writeFileSync?: typeof writeFileSync;
}): GeminiAcpSystemSettingsResult {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'win32') {
        return {
            settingsPath: opts.baseSettingsPath,
            cleanup: () => {}
        };
    }

    const baseSettings = readSettings(opts.baseSettingsPath);
    const mergedSettings = applyWindowsShellOverride(baseSettings);

    const outputDir = opts.outputDir ?? join(tmpdir(), 'hapi', 'gemini-settings');

    try {
        (opts._mkdirSync ?? mkdirSync)(outputDir, { recursive: true });

        const now = opts.now ?? Date.now;
        const random = opts.random ?? Math.random;
        const suffix = Math.floor(random() * 1_000_000_000);
        const filename = `gemini-acp-settings-${process.pid}-${now()}-${suffix}.json`;
        const settingsPath = join(outputDir, filename);

        (opts._writeFileSync ?? writeFileSync)(settingsPath, JSON.stringify(mergedSettings, null, 4));

        return {
            settingsPath,
            cleanup: createCleanup(settingsPath)
        };
    } catch (error) {
        // Non-core capability — degrade to original settings rather than blocking session startup.
        // Shell may misbehave on Windows without the override, so warn visibly.
        logger.warn(`[gemini-settings] Failed to write override settings to ${outputDir}: ${error}`);
        return {
            settingsPath: opts.baseSettingsPath,
            cleanup: () => {}
        };
    }
}
