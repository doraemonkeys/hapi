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

// On Windows, when spawned by the runner daemon (which runs with DETACHED_PROCESS
// and no console), the entire process tree is console-less.  PowerShell and .NET
// applications crash with STATUS_DLL_INIT_FAILED (0xC0000142) because their DLLs
// need console infrastructure during initialization.
// Fix: allocate a hidden console so child processes (PowerShell, apply_patch) work.

// Module-level to prevent GC of FFI handles
let _ffiHandles: unknown[] | undefined;

const startedByIdx = process.argv.indexOf('--started-by');
const startedByRunner = startedByIdx !== -1 && process.argv[startedByIdx + 1] === 'runner';
if (startedByRunner && process.platform === 'win32') {
    try {
        const { dlopen, FFIType } = require('bun:ffi');
        const kernel32 = dlopen('kernel32.dll', {
            AllocConsole: { returns: FFIType.i32, args: [] },
            GetConsoleWindow: { returns: FFIType.ptr, args: [] },
        });
        const user32 = dlopen('user32.dll', {
            ShowWindow: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32] },
        });
        _ffiHandles = [kernel32, user32];

        const allocated = kernel32.symbols.AllocConsole();
        if (allocated) {
            // Hide the console window immediately to avoid a flash
            const hwnd = kernel32.symbols.GetConsoleWindow();
            if (hwnd) {
                user32.symbols.ShowWindow(hwnd, 0); // SW_HIDE = 0
            }
        }
    } catch {
        // FFI not available (e.g. running under Node.js); continue without
    }
}

import { runCli } from './commands/runCli'

void runCli()
