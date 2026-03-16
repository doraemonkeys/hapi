import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexStartConfig } from './codexStartConfig';
import { codexSystemPrompt } from './systemPrompt';
import type { CodexPermissionModeConfig } from './resolvePermissions';

type TestPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

const { resolveCodexPermissionModeConfig } = vi.hoisted(() => ({
    resolveCodexPermissionModeConfig: vi.fn<(mode: TestPermissionMode) => CodexPermissionModeConfig>()
}));

vi.mock('./resolvePermissions', () => ({
    resolveCodexPermissionModeConfig
}));

function approvalPolicyFor(mode: TestPermissionMode): 'on-failure' | 'never' {
    return mode === 'read-only' || mode === 'yolo' ? 'never' : 'on-failure';
}

function buildConfig(
    mode: TestPermissionMode,
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
): CodexPermissionModeConfig {
    const sandboxPolicy = sandbox === 'read-only'
        ? { type: 'readOnly' as const }
        : sandbox === 'workspace-write'
            ? { type: 'workspaceWrite' as const }
            : { type: 'dangerFullAccess' as const };

    return {
        approvalPolicy: approvalPolicyFor(mode),
        sandbox,
        sandboxPolicy
    };
}

function nonWindowsConfig(mode: TestPermissionMode): CodexPermissionModeConfig {
    switch (mode) {
        case 'default':
            return buildConfig(mode, 'workspace-write');
        case 'read-only':
            return buildConfig(mode, 'read-only');
        case 'safe-yolo':
            return buildConfig(mode, 'workspace-write');
        case 'yolo':
            return buildConfig(mode, 'danger-full-access');
    }
}

describe('buildCodexStartConfig', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    beforeEach(() => {
        resolveCodexPermissionModeConfig.mockImplementation(nonWindowsConfig);
    });

    it('applies CLI overrides when permission mode is default', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'default' },
            first: true,
            mcpServers,
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(config.sandbox).toBe('danger-full-access');
        expect(config['approval-policy']).toBe('never');
        expect(config.config).toEqual({
            mcp_servers: mcpServers,
            developer_instructions: codexSystemPrompt
        });
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'yolo' },
            first: false,
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(config.sandbox).toBe('danger-full-access');
        expect(config['approval-policy']).toBe('never');
    });

    it('keeps on-failure approvals for safe-yolo', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'safe-yolo' },
            first: false,
            mcpServers
        });

        expect(config.sandbox).toBe('workspace-write');
        expect(config['approval-policy']).toBe('on-failure');
    });

    it('passes model when provided', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'default', model: 'o3' },
            first: false,
            mcpServers
        });

        expect(config.model).toBe('o3');
    });
});
