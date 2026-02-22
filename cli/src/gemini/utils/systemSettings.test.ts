import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyWindowsShellOverride, prepareGeminiAcpSystemSettings } from './systemSettings';

describe('applyWindowsShellOverride', () => {
    it('preserves existing settings and disables interactive shell', () => {
        const baseSettings: Record<string, unknown> = {
            hooks: {
                SessionStart: [
                    {
                        matcher: '*'
                    }
                ]
            },
            tools: {
                shell: {
                    showColor: true
                }
            }
        };

        const merged = applyWindowsShellOverride(baseSettings);

        expect(merged).toEqual({
            hooks: {
                SessionStart: [
                    {
                        matcher: '*'
                    }
                ]
            },
            tools: {
                shell: {
                    showColor: true,
                    enableInteractiveShell: false
                }
            }
        });

        expect((baseSettings.tools as Record<string, unknown>).shell).toEqual({ showColor: true });
    });
});

describe('prepareGeminiAcpSystemSettings', () => {
    it('passes through base settings on non-Windows', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hapi-gemini-settings-'));
        const baseSettingsPath = join(tempDir, 'settings.json');
        writeFileSync(baseSettingsPath, JSON.stringify({ hooks: { SessionStart: [] } }));

        try {
            const prepared = prepareGeminiAcpSystemSettings({
                baseSettingsPath,
                platform: 'linux',
                outputDir: tempDir
            });

            expect(prepared.settingsPath).toBe(baseSettingsPath);
            prepared.cleanup();
            expect(existsSync(baseSettingsPath)).toBe(true);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('writes an ACP settings override on Windows and cleans it up', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hapi-gemini-settings-'));
        const baseSettingsPath = join(tempDir, 'settings.json');
        writeFileSync(baseSettingsPath, JSON.stringify({
            hooks: {
                SessionStart: [
                    {
                        matcher: '*',
                        hooks: []
                    }
                ]
            }
        }));

        try {
            const prepared = prepareGeminiAcpSystemSettings({
                baseSettingsPath,
                platform: 'win32',
                outputDir: tempDir,
                now: () => 123,
                random: () => 0.5
            });

            expect(prepared.settingsPath).toBeDefined();
            expect(prepared.settingsPath).not.toBe(baseSettingsPath);
            expect(existsSync(prepared.settingsPath!)).toBe(true);

            const written = JSON.parse(readFileSync(prepared.settingsPath!, 'utf-8')) as Record<string, unknown>;
            expect(written).toEqual({
                hooks: {
                    SessionStart: [
                        {
                            matcher: '*',
                            hooks: []
                        }
                    ]
                },
                tools: {
                    shell: {
                        enableInteractiveShell: false
                    }
                }
            });

            prepared.cleanup();
            expect(existsSync(prepared.settingsPath!)).toBe(false);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('produces override-only settings on Windows with no base settings path', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hapi-gemini-settings-'));

        try {
            const prepared = prepareGeminiAcpSystemSettings({
                baseSettingsPath: undefined,
                platform: 'win32',
                outputDir: tempDir,
                now: () => 1,
                random: () => 0.1
            });

            expect(prepared.settingsPath).toBeDefined();
            const written = JSON.parse(readFileSync(prepared.settingsPath!, 'utf-8'));
            expect(written).toEqual({
                tools: { shell: { enableInteractiveShell: false } }
            });

            prepared.cleanup();
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('degrades gracefully on Windows with corrupt base settings file', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hapi-gemini-settings-'));
        const corruptPath = join(tempDir, 'corrupt.json');
        writeFileSync(corruptPath, '{{{ not valid json');

        try {
            const prepared = prepareGeminiAcpSystemSettings({
                baseSettingsPath: corruptPath,
                platform: 'win32',
                outputDir: tempDir,
                now: () => 2,
                random: () => 0.2
            });

            expect(prepared.settingsPath).toBeDefined();
            const written = JSON.parse(readFileSync(prepared.settingsPath!, 'utf-8'));
            expect(written).toEqual({
                tools: { shell: { enableInteractiveShell: false } }
            });

            prepared.cleanup();
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('degrades to base settings path when file write fails', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hapi-gemini-settings-'));
        const baseSettingsPath = join(tempDir, 'settings.json');
        writeFileSync(baseSettingsPath, JSON.stringify({ hooks: {} }));

        try {
            const prepared = prepareGeminiAcpSystemSettings({
                baseSettingsPath,
                platform: 'win32',
                outputDir: tempDir,
                now: () => 3,
                random: () => 0.3,
                _writeFileSync: () => { throw new Error('disk full'); }
            });

            expect(prepared.settingsPath).toBe(baseSettingsPath);
            prepared.cleanup(); // noop — should not throw
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('degrades to base settings path when mkdir fails', () => {
        const prepared = prepareGeminiAcpSystemSettings({
            baseSettingsPath: '/some/original/path.json',
            platform: 'win32',
            outputDir: '/nonexistent',
            _mkdirSync: () => { throw new Error('EACCES'); }
        });

        expect(prepared.settingsPath).toBe('/some/original/path.json');
        prepared.cleanup(); // noop
    });
});
