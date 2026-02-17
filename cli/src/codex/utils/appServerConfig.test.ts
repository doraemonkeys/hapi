import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { buildThreadStartParams, buildTurnStartParams } from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';
import type { SandboxValue } from './resolvePermissions';

/**
 * Platform-independent tests for appServerConfig.
 *
 * `resolveSandboxFromMode` (from resolvePermissions.ts) is mocked so
 * both Windows and non-Windows code paths are exercised regardless of
 * the host OS.
 */

const { resolveSandboxFromMode } = vi.hoisted(() => ({
    resolveSandboxFromMode: vi.fn<(mode: string | undefined) => SandboxValue | undefined>()
}));

vi.mock('./resolvePermissions', () => ({
    resolveSandboxFromMode,
}));

afterEach(() => {
    vi.restoreAllMocks();
});

// Standard non-Windows mapping
function nonWindowsSandbox(mode: string | undefined): SandboxValue | undefined {
    switch (mode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        default: return undefined;
    }
}

// Windows: always danger-full-access
function windowsSandbox(mode: string | undefined): SandboxValue | undefined {
    switch (mode) {
        case 'default':
        case 'read-only':
        case 'safe-yolo':
        case 'yolo':
            return 'danger-full-access';
        default: return undefined;
    }
}

// ---------------------------------------------------------------------------
// Non-Windows (sandbox works normally)
// ---------------------------------------------------------------------------
describe('appServerConfig (non-Windows)', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    beforeEach(() => {
        resolveSandboxFromMode.mockImplementation(nonWindowsSandbox);
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
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            }
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
        const expectations: Record<string, string> = {
            'default': 'workspace-write',
            'read-only': 'read-only',
            'safe-yolo': 'workspace-write',
            'yolo': 'danger-full-access'
        };

        for (const [permissionMode, expectedSandbox] of Object.entries(expectations)) {
            const params = buildThreadStartParams({
                mode: { permissionMode: permissionMode as 'default' | 'read-only' | 'safe-yolo' | 'yolo' },
                mcpServers
            });
            expect(params.sandbox).toBe(expectedSandbox);
        }
    });

    it('resolves sandbox policy per permission mode without Windows override', () => {
        const expectations: Record<string, { type: string }> = {
            'default': { type: 'workspaceWrite' },
            'read-only': { type: 'readOnly' },
            'safe-yolo': { type: 'workspaceWrite' },
            'yolo': { type: 'dangerFullAccess' }
        };

        for (const [permissionMode, expectedPolicy] of Object.entries(expectations)) {
            const params = buildTurnStartParams({
                threadId: 'thread-1',
                message: 'hello',
                mode: { permissionMode: permissionMode as 'default' | 'read-only' | 'safe-yolo' | 'yolo' }
            });
            expect(params.sandboxPolicy).toEqual(expectedPolicy);
        }
    });
});

// ---------------------------------------------------------------------------
// Windows (sandbox broken — all modes forced to danger-full-access)
// ---------------------------------------------------------------------------
describe('appServerConfig (Windows sandbox override)', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    beforeEach(() => {
        resolveSandboxFromMode.mockImplementation(windowsSandbox);
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

    it('forces dangerFullAccess even when CLI overrides specify a different sandbox', () => {
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
