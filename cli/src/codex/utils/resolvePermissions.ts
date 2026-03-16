import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { ApprovalPolicy, SandboxMode, SandboxPolicy } from '../appServerTypes';

/**
 * Shared permission-mode resolution for Codex launch paths.
 *
 * Thread start, turn start, local CLI launch, and remote approval handling
 * must all agree on the same policy mapping. When they drift, fork modes
 * behave differently depending on transport.
 */

/**
 * Codex's workspace-write sandbox cannot spawn child processes on Windows
 * in app-server mode (STATUS_DLL_INIT_FAILED / 0xC0000142).
 * The detached process tree lacks console context required for DLL init.
 * Fall back to danger-full-access since the sandbox provides zero
 * protection when it can't run anything.
 *
 * Set HAPI_CODEX_SANDBOX=1 to disable this workaround (e.g. after a
 * Codex update that fixes sandbox on Windows).
 */
const SANDBOX_BROKEN_ON_WINDOWS =
    process.platform === 'win32' && process.env.HAPI_CODEX_SANDBOX !== '1';

const APPROVAL_POLICY_BY_MODE: Record<CodexPermissionMode, ApprovalPolicy> = {
    default: 'on-failure',
    'read-only': 'never',
    'safe-yolo': 'on-failure',
    yolo: 'on-failure'
};

const SANDBOX_BY_MODE: Record<CodexPermissionMode, SandboxMode> = {
    default: 'workspace-write',
    'read-only': 'read-only',
    'safe-yolo': 'workspace-write',
    yolo: 'danger-full-access'
};

const SANDBOX_POLICY_BY_MODE: Record<SandboxMode, SandboxPolicy> = {
    'read-only': { type: 'readOnly' },
    'workspace-write': { type: 'workspaceWrite' },
    'danger-full-access': { type: 'dangerFullAccess' }
};

export type SandboxValue = SandboxMode;

export type CodexPermissionModeConfig = {
    approvalPolicy: ApprovalPolicy;
    sandbox: SandboxMode;
    sandboxPolicy: SandboxPolicy;
};

function applyPlatformSandboxOverride(sandbox: SandboxMode): SandboxMode {
    return SANDBOX_BROKEN_ON_WINDOWS ? 'danger-full-access' : sandbox;
}

export function isCodexPermissionMode(permissionMode: string | undefined): permissionMode is CodexPermissionMode {
    return permissionMode === 'default'
        || permissionMode === 'read-only'
        || permissionMode === 'safe-yolo'
        || permissionMode === 'yolo';
}

export function resolveCodexPermissionModeConfig(permissionMode: CodexPermissionMode): CodexPermissionModeConfig {
    const sandbox = applyPlatformSandboxOverride(SANDBOX_BY_MODE[permissionMode]);
    return {
        approvalPolicy: APPROVAL_POLICY_BY_MODE[permissionMode],
        sandbox,
        sandboxPolicy: SANDBOX_POLICY_BY_MODE[sandbox]
    };
}

export function tryResolveCodexPermissionModeConfig(
    permissionMode: string | undefined
): CodexPermissionModeConfig | undefined {
    if (!isCodexPermissionMode(permissionMode)) {
        return undefined;
    }

    return resolveCodexPermissionModeConfig(permissionMode);
}

export function resolveApprovalPolicyFromMode(permissionMode: string | undefined): ApprovalPolicy | undefined {
    return tryResolveCodexPermissionModeConfig(permissionMode)?.approvalPolicy;
}

export function resolveSandboxFromMode(permissionMode: string | undefined): SandboxValue | undefined {
    return tryResolveCodexPermissionModeConfig(permissionMode)?.sandbox;
}

export function resolveSandboxPolicyFromMode(permissionMode: string | undefined): SandboxPolicy | undefined {
    return tryResolveCodexPermissionModeConfig(permissionMode)?.sandboxPolicy;
}

export function resolveSandboxPolicyOverride(value: SandboxMode | undefined): SandboxPolicy | undefined {
    return value ? SANDBOX_POLICY_BY_MODE[value] : undefined;
}
