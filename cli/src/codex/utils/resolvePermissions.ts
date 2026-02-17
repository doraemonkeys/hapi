/**
 * Shared sandbox/approval resolution for Codex permission modes.
 *
 * Three call-sites (appServerConfig, codexStartConfig, codexLocalLauncher)
 * previously duplicated this logic.  Two of the three were missing the
 * Windows override, causing sandbox failures on win32.
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

export type SandboxValue = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Map a permission-mode string to the corresponding Codex sandbox value.
 * Returns `undefined` for unrecognised modes so callers can decide whether
 * to throw or fall through.
 */
export function resolveSandboxFromMode(permissionMode: string | undefined): SandboxValue | undefined {
    if (SANDBOX_BROKEN_ON_WINDOWS) return 'danger-full-access';
    switch (permissionMode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        default: return undefined;
    }
}
