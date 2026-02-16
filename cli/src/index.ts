#!/usr/bin/env bun

// When spawned by the runner in dev mode, cwd is set to the CLI project root
// (so Bun can resolve tsconfig path aliases). The actual working directory is
// passed via HAPI_SPAWN_CWD — but we MUST NOT chdir here, because Bun resolves
// dynamic import() path aliases based on current cwd. Changing cwd before
// command handlers run their dynamic imports breaks @/ resolution.
// Instead, save the value and let each command handler apply it after imports.
import { setDeferredCwd } from './utils/deferredCwd'

if (process.env.HAPI_SPAWN_CWD) {
    setDeferredCwd(process.env.HAPI_SPAWN_CWD)
    delete process.env.HAPI_SPAWN_CWD
}

import './utils/enrichPath'

import { runCli } from './commands/runCli'

void runCli()
