import { afterEach, describe, expect, it, vi } from 'vitest';

const { harness, permissionConfigs } = vi.hoisted(() => ({
    harness: {
        launches: [] as Array<Record<string, unknown>>
    },
    permissionConfigs: {
        default: {
            approvalPolicy: 'on-failure',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        },
        'read-only': {
            approvalPolicy: 'never',
            sandbox: 'read-only',
            sandboxPolicy: { type: 'readOnly' }
        },
        'safe-yolo': {
            approvalPolicy: 'on-failure',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        },
        yolo: {
            approvalPolicy: 'on-failure',
            sandbox: 'danger-full-access',
            sandboxPolicy: { type: 'dangerFullAccess' }
        }
    } as const
}));

vi.mock('./codexLocal', () => ({
    codexLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            url: 'http://localhost:0',
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('./utils/codexSessionScanner', () => ({
    createCodexSessionScanner: async () => ({
        cleanup: async () => {},
        onNewSession: () => {}
    })
}));

vi.mock('./utils/resolvePermissions', () => ({
    isCodexPermissionMode: (mode: string | undefined): mode is keyof typeof permissionConfigs => (
        mode === 'default' || mode === 'read-only' || mode === 'safe-yolo' || mode === 'yolo'
    ),
    resolveCodexPermissionModeConfig: (mode: keyof typeof permissionConfigs) => permissionConfigs[mode]
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        readonly control = {
            requestExit: () => {}
        };

        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}

        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            return 'exit';
        }
    }
}));

import { codexLocalLauncher } from './codexLocalLauncher';

function createSessionStub(permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo', codexArgs?: string[]) {
    return {
        sessionId: null,
        path: '/tmp/worktree',
        startedBy: 'terminal' as const,
        startingMode: 'local' as const,
        codexArgs,
        client: {
            rpcHandlerManager: {}
        },
        getPermissionMode: () => permissionMode,
        onSessionFound: () => {},
        sendSessionEvent: () => {},
        recordLocalLaunchFailure: () => {},
        sendUserMessage: () => {},
        sendCodexMessage: () => {},
        queue: {}
    };
}

describe('codexLocalLauncher', () => {
    afterEach(() => {
        harness.launches = [];
    });

    it('rebuilds managed approval settings from yolo mode', async () => {
        const session = createSessionStub('yolo', [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'never',
            '--model',
            'o3',
            '--full-auto'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]).toMatchObject({
            approvalPolicy: 'on-failure',
            sandbox: 'danger-full-access',
            codexArgs: ['--model', 'o3']
        });
    });

    it('preserves raw Codex approval flags in default mode', async () => {
        const session = createSessionStub('default', [
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]).toMatchObject({
            approvalPolicy: 'on-failure',
            sandbox: 'workspace-write',
            codexArgs: [
                '--ask-for-approval',
                'on-request',
                '--sandbox',
                'workspace-write',
                '--model',
                'o3'
            ]
        });
    });
});
