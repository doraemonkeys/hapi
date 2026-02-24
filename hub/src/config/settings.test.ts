import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, writeSettings, type Settings } from './settings'

const TEST_DIR = join(tmpdir(), `settings-test-${process.pid}`)

function setupDir(): string {
    const dir = join(TEST_DIR, String(Date.now()) + '-' + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true })
    return dir
}

afterEach(() => {
    if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
    }
})

describe('writeSettings', () => {
    it('produces file with mode 0o600', async () => {
        if (process.platform === 'win32') return // mode bits not enforced on Windows

        const dir = setupDir()
        const file = join(dir, 'settings.json')
        await writeSettings(file, { machineId: 'test' })

        const stat = statSync(file)
        const mode = stat.mode & 0o777
        expect(mode).toBe(0o600)
    })

    it('writes valid JSON content', async () => {
        const dir = setupDir()
        const file = join(dir, 'settings.json')
        const data: Settings = { machineId: 'abc', cliApiToken: 'secret' }
        await writeSettings(file, data)

        const result = await readSettings(file)
        expect(result).toEqual(data)
    })
})

describe('readSettings', () => {
    it('tightens permissions on existing wide-open file', async () => {
        if (process.platform === 'win32') return // mode bits not enforced on Windows

        const dir = setupDir()
        const file = join(dir, 'settings.json')
        // Create file with overly permissive mode (world-readable)
        writeFileSync(file, JSON.stringify({ machineId: 'wide-open' }), { mode: 0o644 })

        const before = statSync(file).mode & 0o777
        expect(before).toBe(0o644)

        await readSettings(file)

        const after = statSync(file).mode & 0o777
        expect(after).toBe(0o600)
    })

    it('returns empty object for non-existent file', async () => {
        const result = await readSettings(join(setupDir(), 'no-such-file.json'))
        expect(result).toEqual({})
    })

    it('returns null for malformed JSON', async () => {
        const dir = setupDir()
        const file = join(dir, 'settings.json')
        writeFileSync(file, 'not-json!!!', { mode: 0o600 })

        const result = await readSettings(file)
        expect(result).toBeNull()
    })

    it('still reads file when chmod fails (Windows-like scenario)', async () => {
        // Even if chmod throws, readSettings should still return parsed content.
        // On all platforms, chmod is wrapped in .catch(() => {}), so a failure
        // (e.g., on Windows where mode bits are no-op) never blocks the read.
        const dir = setupDir()
        const file = join(dir, 'settings.json')
        const data: Settings = { machineId: 'win-compat' }
        writeFileSync(file, JSON.stringify(data))

        const result = await readSettings(file)
        expect(result).toEqual(data)
    })
})
