/**
 * Tool version manager PATH discovery
 *
 * In service/daemon contexts (e.g., NSSM on Windows, systemd on Linux),
 * the process environment may not include PATH entries from tool version
 * managers like mise, nvm, volta, etc. — because shell profiles are not
 * loaded for non-interactive sessions.
 *
 * This utility discovers those directories and augments PATH so that
 * commands installed via tool managers (e.g., `gemini` via npm in mise-managed node)
 * are reachable from spawned child processes.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/ui/logger'

const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'

/**
 * Discover PATH entries from tool version managers.
 * Returns directories that contain executables but may not be on the current PATH.
 */
export function discoverToolManagerPaths(): string[] {
    const paths: string[] = []
    const home = homedir()

    // mise (formerly rtx) — manages node, python, ruby, etc.
    // Windows: %LOCALAPPDATA%\mise\installs\<tool>\<version>\
    // Unix:    ~/.local/share/mise/installs/<tool>/<version>/bin
    if (process.platform === 'win32') {
        collectMisePaths(join(home, 'AppData', 'Local', 'mise', 'installs'), 'windows', paths)
    } else {
        collectMisePaths(join(home, '.local', 'share', 'mise', 'installs'), 'unix', paths)
    }

    // npm global bin — Windows only (Unix npm globals are usually in /usr/local/bin)
    if (process.platform === 'win32') {
        const npmGlobal = join(home, 'AppData', 'Roaming', 'npm')
        if (existsSync(npmGlobal)) {
            paths.push(npmGlobal)
        }
    }

    // bun global bin
    const bunBin = join(home, '.bun', 'bin')
    if (existsSync(bunBin)) {
        paths.push(bunBin)
    }

    return paths
}

/**
 * Scan mise install directories for tool binaries.
 * mise layout: <base>/<tool>/<version>/ (Windows) or <base>/<tool>/<version>/bin (Unix)
 */
function collectMisePaths(base: string, platform: 'windows' | 'unix', out: string[]): void {
    if (!existsSync(base)) return

    let tools: string[]
    try {
        tools = readdirSync(base)
    } catch {
        return
    }

    for (const tool of tools) {
        const toolDir = join(base, tool)
        let versions: string[]
        try {
            versions = readdirSync(toolDir)
        } catch {
            continue
        }

        for (const version of versions) {
            const versionDir = join(toolDir, version)
            if (platform === 'windows') {
                // On Windows, executables live directly in the version directory
                if (existsSync(versionDir)) {
                    out.push(versionDir)
                }
            } else {
                // On Unix, executables live in <version>/bin
                const binDir = join(versionDir, 'bin')
                if (existsSync(binDir)) {
                    out.push(binDir)
                }
            }
        }
    }
}

/**
 * Augment a PATH string with tool version manager directories.
 * Deduplicates entries (case-insensitive on Windows).
 */
export function augmentPathWithToolManagers(currentPath: string): string {
    const extraPaths = discoverToolManagerPaths()
    if (extraPaths.length === 0) return currentPath

    const normalize = process.platform === 'win32'
        ? (p: string) => p.toLowerCase().replace(/\\/g, '/')
        : (p: string) => p

    const existing = new Set(currentPath.split(PATH_SEPARATOR).map(normalize))
    const newPaths = extraPaths.filter(p => !existing.has(normalize(p)))

    if (newPaths.length === 0) return currentPath

    logger.debug(`[toolPaths] Augmenting PATH with ${newPaths.length} tool manager entries: ${newPaths.join(', ')}`)
    return currentPath + PATH_SEPARATOR + newPaths.join(PATH_SEPARATOR)
}
