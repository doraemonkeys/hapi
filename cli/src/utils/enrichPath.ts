/**
 * Process-level PATH enrichment for tool version managers.
 *
 * When the CLI runs as a compiled binary (or outside an interactive shell),
 * PATH entries injected by tool version managers (mise, volta, nvm, fnm) are
 * absent — their shell hooks never ran.  This module detects installed
 * managers and prepends their bin/shim directories to `process.env.PATH`
 * so that every subsequent `spawn()` inherits a usable PATH.
 *
 * Designed to be imported as a side-effect module: the enrichment runs
 * during ESM module evaluation, before any spawn calls.
 *
 * Constraints: synchronous, < 10ms, no execSync — only existsSync / readdirSync.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const isWin = process.platform === 'win32';
const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
const SEP = isWin ? ';' : ':';

/**
 * Find the actual key name used for PATH in `process.env`.
 * Windows env keys are case-insensitive; the real key may be `Path`, `PATH`,
 * or another casing.  We must mutate the *same* key to avoid creating a
 * duplicate entry under Bun.
 */
function pathKey(): string {
    return Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
}

/**
 * Collect candidate directories from all detected tool version managers.
 * Each entry is an absolute directory path (not a file path).
 */
function collectCandidateDirs(): string[] {
    const dirs: string[] = [];

    // --- mise ---
    collectMiseDirs(dirs);

    // --- volta ---
    collectVoltaDirs(dirs);

    // --- fnm ---
    collectFnmDirs(dirs);

    // --- nvm ---
    collectNvmDirs(dirs);

    return dirs;
}

// ---------------------------------------------------------------------------
// Per-manager collectors
// ---------------------------------------------------------------------------

function collectMiseDirs(dirs: string[]): void {
    // Shims directory
    const miseShimsDirs = [
        process.env.MISE_SHIMS_DIR,
        isWin
            ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'mise', 'shims')
            : join(home, '.local', 'share', 'mise', 'shims'),
    ];
    for (const d of miseShimsDirs) {
        if (d && isAbsolute(d) && existsSync(d)) {
            dirs.push(d);
            break; // only add one shims dir
        }
    }

    // Active node version bin directory — globally-installed npm packages
    // (like codex) land here, not in shims.
    // Strategy: list mise/installs/node/ versions, pick newest by sort order.
    const miseNodeParents = [
        isWin
            ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'mise', 'installs', 'node')
            : null,
        join(home, '.local', 'share', 'mise', 'installs', 'node'),
    ].filter(Boolean) as string[];

    for (const nodeParent of miseNodeParents) {
        if (!isAbsolute(nodeParent) || !existsSync(nodeParent)) continue;
        try {
            const versions = readdirSync(nodeParent).sort().reverse();
            if (versions.length > 0) {
                const binDir = isWin
                    ? join(nodeParent, versions[0])
                    : join(nodeParent, versions[0], 'bin');
                if (existsSync(binDir)) {
                    dirs.push(binDir);
                }
                break; // found a valid version dir
            }
        } catch {
            // permission error or similar — skip
        }
    }
}

function collectVoltaDirs(dirs: string[]): void {
    const voltaBin = process.env.VOLTA_HOME
        ? join(process.env.VOLTA_HOME, 'bin')
        : join(home, '.volta', 'bin');
    if (isAbsolute(voltaBin) && existsSync(voltaBin)) {
        dirs.push(voltaBin);
    }
}

function collectFnmDirs(dirs: string[]): void {
    const fnmDir = process.env.FNM_MULTISHELL_PATH;
    if (fnmDir && isAbsolute(fnmDir) && existsSync(fnmDir)) {
        dirs.push(fnmDir);
    }
}

function collectNvmDirs(dirs: string[]): void {
    if (isWin) {
        // Windows nvm uses NVM_SYMLINK for the active version
        const symlink = process.env.NVM_SYMLINK;
        if (symlink && isAbsolute(symlink) && existsSync(symlink)) {
            dirs.push(symlink);
        }
    } else {
        // Unix: $NVM_DIR/versions/node/<version>/bin — pick newest
        const nvmDir = process.env.NVM_DIR;
        if (!nvmDir || !isAbsolute(nvmDir)) return;
        const nodeParent = join(nvmDir, 'versions', 'node');
        if (!existsSync(nodeParent)) return;
        try {
            const versions = readdirSync(nodeParent).sort().reverse();
            if (versions.length > 0) {
                const binDir = join(nodeParent, versions[0], 'bin');
                if (existsSync(binDir)) {
                    dirs.push(binDir);
                }
            }
        } catch {
            // skip
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect tool version managers and prepend their bin/shim directories to
 * `process.env.PATH`.  Idempotent — directories already present in PATH
 * are not added again.
 */
export function enrichProcessPath(): void {
    const key = pathKey();
    const currentPath = process.env[key] ?? '';
    const existingEntries = new Set(currentPath.split(SEP));

    const candidates = collectCandidateDirs();
    // Filter out dirs already in PATH and any non-absolute paths (defensive)
    const toAdd = candidates.filter(d => isAbsolute(d) && !existingEntries.has(d));

    if (toAdd.length === 0) return;

    process.env[key] = [...toAdd, currentPath].join(SEP);
}

// Execute on import — runs during ESM module evaluation
enrichProcessPath();
