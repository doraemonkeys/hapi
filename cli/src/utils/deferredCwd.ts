/**
 * Deferred chdir for runner-spawned processes.
 *
 * In dev mode, the runner spawns child processes with cwd set to the CLI
 * project root (so Bun can find tsconfig.json and resolve @/ path aliases).
 * The actual working directory is passed via HAPI_SPAWN_CWD.
 *
 * We cannot call process.chdir() in index.ts because Bun resolves dynamic
 * import() path aliases based on the current cwd. Changing cwd before command
 * handlers run their dynamic imports (e.g. `await import('@/codex/runCodex')`)
 * would break @/ resolution.
 *
 * Instead, index.ts saves the value here, and each command handler calls
 * applyDeferredCwd() after its dynamic imports are done.
 */

let _deferredCwd: string | undefined

export function setDeferredCwd(cwd: string): void {
    _deferredCwd = cwd
}

export function applyDeferredCwd(): void {
    if (_deferredCwd) {
        try { process.chdir(_deferredCwd) } catch {}
        _deferredCwd = undefined
    }
}
