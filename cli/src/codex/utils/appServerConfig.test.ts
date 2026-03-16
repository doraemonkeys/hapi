import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildThreadStartParams, buildTurnStartParams } from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';
import type { CodexPermissionModeConfig } from './resolvePermissions';

type SandboxValue = 'read-only' | 'workspace-write' | 'danger-full-access';
type TestPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

const { resolveCodexPermissionModeConfig, sandboxPolicies } = vi.hoisted(() => ({
    resolveCodexPermissionModeConfig: vi.fn<(mode: TestPermissionMode) => CodexPermissionModeConfig>(),
    sandboxPolicies: {
        'read-only': { type: 'readOnly' },
        'workspace-write': { type: 'workspaceWrite' },
        'danger-full-access': { type: 'dangerFullAccess' }
    } as const
}));

vi.mock('./resolvePermissions', () => ({
    resolveCodexPermissionModeConfig,
    resolveSandboxPolicyOverride: (sandbox: SandboxValue | undefined) => (
        sandbox ? sandboxPolicies[sandbox] : undefined
    )
}));

afterEach(() => {
    resolveCodexPermissionModeConfig.mockReset();
});

function approvalPolicyFor(mode: TestPermissionMode): 'on-failure' | 'never' {
    return mode === 'read-only' ? 'never' : 'on-failure';
}

function buildConfig(mode: TestPermissionMode, sandbox: SandboxValue): CodexPermissionModeConfig {
    return {
        approvalPolicy: approvalPolicyFor(mode),
        sandbox,
        sandboxPolicy: sandboxPolicies[sandbox]
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

function windowsConfig(mode: TestPermissionMode): CodexPermissionModeConfig {
    switch (mode) {
        case 'default':
        case 'read-only':
        case 'safe-yolo':
        case 'yolo':
            return buildConfig(mode, 'danger-full-access');
    }
}

describe('appServerConfig (non-Windows)', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    beforeEach(() => {
        resolveCodexPermissionModeConfig.mockImplementation(nonWindowsConfig);
    });

    it('applies CLI overrides when permission mode is default', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'default' },
            mcpServers,
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('never');
        expect(params.baseInstructions).toBe(codexSystemPrompt);
        expect(params.developerInstructions).toBe(codexSystemPrompt);
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: codexSystemPrompt
        });
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'yolo' },
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('on-failure');
    });

    it('concatenates custom developer instructions after base instructions', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'default' },
            mcpServers,
            developerInstructions: 'Only respond in Chinese.'
        });

        expect(params.baseInstructions).toBe(codexSystemPrompt);
        expect(params.developerInstructions).toBe(`${codexSystemPrompt}\n\nOnly respond in Chinese.`);
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: `${codexSystemPrompt}\n\nOnly respond in Chinese.`
        });
    });

    it('builds turn params with mode defaults', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'read-only', model: 'o3' }
        });

        expect(params.threadId).toBe('thread-1');
        expect(params.input).toEqual([{ type: 'text', text: 'hello' }]);
        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'readOnly' });
        expect(params.model).toBe('o3');
    });

    it('puts collaboration mode in turn params with model settings', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'plan' }
        });

        expect(params.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'o3' } });
        expect(params.model).toBeUndefined();
    });

    it('applies CLI overrides for turns when permission mode is default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default' },
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    });

    it('ignores CLI overrides for turns when permission mode is not default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'safe-yolo' },
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('on-failure');
        expect(params.sandboxPolicy).toEqual({ type: 'workspaceWrite' });
    });

    it('prefers turn overrides', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'default' },
            overrides: { approvalPolicy: 'on-request', model: 'gpt-5' }
        });

        expect(params.approvalPolicy).toBe('on-request');
        expect(params.model).toBe('gpt-5');
    });

    it('resolves sandbox per permission mode without Windows override', () => {
        const expectations: Record<TestPermissionMode, SandboxValue> = {
            default: 'workspace-write',
            'read-only': 'read-only',
            'safe-yolo': 'workspace-write',
            yolo: 'danger-full-access'
        };

        for (const [permissionMode, expectedSandbox] of Object.entries(expectations)) {
            const params = buildThreadStartParams({
                mode: { permissionMode: permissionMode as TestPermissionMode },
                mcpServers
            });
            expect(params.sandbox).toBe(expectedSandbox);
        }
    });

    it('resolves sandbox policy per permission mode without Windows override', () => {
        const expectations: Record<TestPermissionMode, { type: string }> = {
            default: { type: 'workspaceWrite' },
            'read-only': { type: 'readOnly' },
            'safe-yolo': { type: 'workspaceWrite' },
            yolo: { type: 'dangerFullAccess' }
        };

        for (const [permissionMode, expectedPolicy] of Object.entries(expectations)) {
            const params = buildTurnStartParams({
                threadId: 'thread-1',
                message: 'hello',
                mode: { permissionMode: permissionMode as TestPermissionMode }
            });
            expect(params.sandboxPolicy).toEqual(expectedPolicy);
        }
    });
});

describe('appServerConfig (Windows sandbox override)', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    beforeEach(() => {
        resolveCodexPermissionModeConfig.mockImplementation(windowsConfig);
    });

    it('forces danger-full-access sandbox for thread params', () => {
        const params = buildThreadStartParams({
            mode: { permissionMode: 'read-only' },
            mcpServers
        });

        expect(params.sandbox).toBe('danger-full-access');
    });

    it('forces dangerFullAccess sandbox policy for turn params', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'read-only', model: 'o3' }
        });

        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    });

    it('forces dangerFullAccess even when CLI overrides are ignored', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            mode: { permissionMode: 'safe-yolo' },
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    });

    it('forces danger-full-access sandbox for all thread permission modes', () => {
        for (const permissionMode of ['default', 'read-only', 'safe-yolo', 'yolo'] as const) {
            const params = buildThreadStartParams({
                mode: { permissionMode },
                mcpServers
            });
            expect(params.sandbox).toBe('danger-full-access');
        }
    });

    it('forces dangerFullAccess sandbox policy for all turn permission modes', () => {
        for (const permissionMode of ['default', 'read-only', 'safe-yolo', 'yolo'] as const) {
            const params = buildTurnStartParams({
                threadId: 'thread-1',
                message: 'hello',
                mode: { permissionMode }
            });
            expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
        }
    });
});
