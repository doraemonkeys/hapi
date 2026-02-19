import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalBackendError } from './backend'
import { getWindowsSidecarPathCandidates, resolveWindowsSidecarPath, WindowsBackend } from './windowsBackend'

class FakeSidecarProcess extends EventEmitter {
    readonly stdin = new PassThrough()
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    readonly pid = 1234
    killed = false
    exitCode: number | null = null

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killed = true
        const normalizedSignal = typeof signal === 'string' ? signal : null
        this.emit('exit', this.exitCode, normalizedSignal)
        return true
    }
}

function createBackendWithFakeProcess(options: {
    process: FakeSidecarProcess
    helloTimeoutMs?: number
    heartbeatIntervalMs?: number
    heartbeatTimeoutMs?: number
}): { backend: WindowsBackend; stdinLines: () => string[] } {
    const stdinBuffer: string[] = []
    options.process.stdin.on('data', (chunk: Buffer | string) => {
        stdinBuffer.push((typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim())
    })

    const backend = new WindowsBackend({
        resolveSidecarPath: () => 'C:/tools/hapi-pty.exe',
        spawnProcess: () => options.process as never,
        helloTimeoutMs: options.helloTimeoutMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        heartbeatTimeoutMs: options.heartbeatTimeoutMs
    })

    return {
        backend,
        stdinLines: () => stdinBuffer.filter((line) => line.length > 0)
    }
}

function emitSidecarEvent(process: FakeSidecarProcess, event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => {
        process.nextTick(resolve)
    })
    await Promise.resolve()
}

afterEach(() => {
    vi.useRealTimers()
})

describe('resolveWindowsSidecarPath', () => {
    it('resolves sidecar path by env -> executable directory -> development fallback', () => {
        const envPath = 'D:/override/hapi-pty.exe'
        const execPath = 'C:/Program Files/Hapi/hapi.exe'
        const moduleDir = 'E:/repo/cli/src/terminal'
        const devPath = resolve(moduleDir, '../../bin/hapi-pty.exe')

        const candidates = getWindowsSidecarPathCandidates({
            env: { HAPI_PTY_PATH: envPath },
            execPath,
            moduleDir
        })

        expect(candidates).toHaveLength(3)
        expect(candidates[0]).toBe(envPath)
        expect(candidates[1].replaceAll('\\', '/')).toBe('C:/Program Files/Hapi/hapi-pty.exe')
        expect(candidates[2].replaceAll('\\', '/')).toBe(devPath.replaceAll('\\', '/'))

        const resolvedEnv = resolveWindowsSidecarPath({
            env: { HAPI_PTY_PATH: envPath },
            execPath,
            moduleDir,
            exists: (path) => path === envPath
        })
        expect(resolvedEnv).toBe(envPath)

        const resolvedExec = resolveWindowsSidecarPath({
            env: {},
            execPath,
            moduleDir,
            exists: (path) => path.replaceAll('\\', '/') === 'C:/Program Files/Hapi/hapi-pty.exe'
        })
        expect(resolvedExec?.replaceAll('\\', '/')).toBe('C:/Program Files/Hapi/hapi-pty.exe')

        const resolvedDev = resolveWindowsSidecarPath({
            env: {},
            execPath,
            moduleDir,
            exists: (path) => path === devPath
        })
        expect(resolvedDev?.replaceAll('\\', '/')).toBe(devPath.replaceAll('\\', '/'))
    })
})

describe('WindowsBackend', () => {
    it('validates hello handshake before forwarding open requests', async () => {
        const process = new FakeSidecarProcess()
        const { backend, stdinLines } = createBackendWithFakeProcess({ process })
        const readyEvents: string[] = []
        const errors: TerminalBackendError[] = []

        backend.onReady((terminalId) => readyEvents.push(terminalId))
        backend.onError((_terminalId, error) => errors.push(error))

        backend.create({
            terminalId: 'term-1',
            cwd: 'C:/repo',
            env: { KEY: 'VALUE' },
            cols: 80,
            rows: 24
        })

        emitSidecarEvent(process, { type: 'hello', version: '1.0.0', protocol: 1 })
        await flushMicrotasks()

        const openMessage = stdinLines()
            .map((line) => JSON.parse(line) as { type: string; terminalId?: string })
            .find((line) => line.type === 'open')
        expect(openMessage).toMatchObject({ type: 'open', terminalId: 'term-1' })

        emitSidecarEvent(process, { type: 'ready', terminalId: 'term-1', displayName: 'pwsh' })
        await flushMicrotasks()

        expect(readyEvents).toEqual(['term-1'])
        expect(errors).toHaveLength(0)
    })

    it('propagates sidecar_protocol_mismatch when hello protocol differs', async () => {
        const process = new FakeSidecarProcess()
        const { backend } = createBackendWithFakeProcess({ process })
        const errors: Array<{ terminalId: string; error: TerminalBackendError }> = []
        backend.onError((terminalId, error) => errors.push({ terminalId, error }))

        backend.create({
            terminalId: 'term-2',
            cwd: 'C:/repo',
            env: {},
            cols: 80,
            rows: 24
        })

        emitSidecarEvent(process, { type: 'hello', version: '1.0.0', protocol: 99 })
        await flushMicrotasks()

        expect(errors).toEqual([
            {
                terminalId: 'term-2',
                error: {
                    code: 'sidecar_protocol_mismatch',
                    message: 'Sidecar protocol mismatch. Expected 1, got 99.'
                }
            }
        ])
    })

    it('times out when sidecar hello is missing', async () => {
        vi.useFakeTimers()
        const process = new FakeSidecarProcess()
        const { backend } = createBackendWithFakeProcess({
            process,
            helloTimeoutMs: 20
        })
        const errors: Array<{ terminalId: string; error: TerminalBackendError }> = []
        backend.onError((terminalId, error) => errors.push({ terminalId, error }))

        backend.create({
            terminalId: 'term-3',
            cwd: 'C:/repo',
            env: {},
            cols: 80,
            rows: 24
        })

        await vi.advanceTimersByTimeAsync(21)
        await flushMicrotasks()

        expect(errors).toEqual([
            {
                terminalId: 'term-3',
                error: {
                    code: 'sidecar_crashed',
                    message: 'Timed out waiting for sidecar hello.'
                }
            }
        ])
    })

    it('emits sidecar_timeout when heartbeat pongs stop', async () => {
        vi.useFakeTimers()
        const process = new FakeSidecarProcess()
        const { backend } = createBackendWithFakeProcess({
            process,
            heartbeatIntervalMs: 10,
            heartbeatTimeoutMs: 25
        })
        const errors: Array<{ terminalId: string; error: TerminalBackendError }> = []
        backend.onError((terminalId, error) => errors.push({ terminalId, error }))

        backend.create({
            terminalId: 'term-4',
            cwd: 'C:/repo',
            env: {},
            cols: 80,
            rows: 24
        })

        emitSidecarEvent(process, { type: 'hello', version: '1.0.0', protocol: 1 })
        await flushMicrotasks()

        await vi.advanceTimersByTimeAsync(35)
        await flushMicrotasks()

        expect(errors).toContainEqual({
            terminalId: 'term-4',
            error: {
                code: 'sidecar_timeout',
                message: 'Windows terminal sidecar heartbeat timed out.'
            }
        })
    })
})
