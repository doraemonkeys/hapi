import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

// vi.hoisted runs before vi.mock, so mock fns are available when the factory
// executes during module evaluation (including the side-effect call).
const { mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
    mockExistsSync: vi.fn<(path: string) => boolean>().mockReturnValue(false),
    mockReaddirSync: vi.fn<(path: string) => string[]>().mockReturnValue([]),
}))

vi.mock('node:fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...(args as [string])),
}))

// Store original process.env to restore after each test
const originalEnv = process.env

// Platform-specific constants matching the source module.
// The source reads process.platform at module scope, so these reflect the
// actual test-runner platform.
const isWin = process.platform === 'win32'
const SEP = isWin ? ';' : ':'

// The source module captures `home` at module scope from the REAL process.env.
// We compute the same value here so tests can derive expected default paths.
const capturedHome = originalEnv.HOME ?? originalEnv.USERPROFILE ?? ''

// Import the named export. The side-effect call at module scope will fire
// once with our mocked existsSync returning false, so it's a no-op.
import { enrichProcessPath } from './enrichPath'

describe('enrichProcessPath', () => {
    beforeEach(() => {
        // Give each test a clean, minimal process.env with a known PATH value.
        // We deliberately construct a fresh object so tests can add/remove keys
        // without polluting the real environment.
        process.env = {
            PATH: '/usr/bin',
            HOME: '/home/testuser',
            USERPROFILE: 'C:\\Users\\testuser',
        }
        mockExistsSync.mockReset().mockReturnValue(false)
        mockReaddirSync.mockReset().mockReturnValue([])
    })

    afterEach(() => {
        process.env = originalEnv
    })

    // -----------------------------------------------------------------------
    // 1. No manager dirs -> PATH unchanged
    // -----------------------------------------------------------------------

    it('leaves PATH unchanged when no manager directories exist', () => {
        const before = process.env.PATH
        enrichProcessPath()
        expect(process.env.PATH).toBe(before)
    })

    // -----------------------------------------------------------------------
    // 2. mise shims dir exists -> PATH prepended with shims dir
    // -----------------------------------------------------------------------

    it('prepends mise shims dir when it exists on disk (via MISE_SHIMS_DIR)', () => {
        const shimsDir = isWin
            ? 'C:\\custom\\mise\\shims'
            : '/custom/mise/shims'
        process.env.MISE_SHIMS_DIR = shimsDir

        mockExistsSync.mockImplementation((p: string) => p === shimsDir)

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries[0]).toBe(shimsDir)
    })

    it('prepends mise shims dir from well-known location', () => {
        // The source uses LOCALAPPDATA (Windows) or the captured home (Unix)
        // to derive the default shims location.
        const shimsDir = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\mise\\shims'
            : join(capturedHome, '.local', 'share', 'mise', 'shims')

        if (isWin) {
            process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local'
        }

        mockExistsSync.mockImplementation((p: string) => p === shimsDir)

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries[0]).toBe(shimsDir)
    })

    // -----------------------------------------------------------------------
    // 3. mise node version bin dir exists -> PATH prepended with version bin dir
    // -----------------------------------------------------------------------

    it('prepends mise node version bin dir when versions are installed', () => {
        const nodeParent = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\mise\\installs\\node'
            : join(capturedHome, '.local', 'share', 'mise', 'installs', 'node')
        const newestBin = isWin
            ? join(nodeParent, '22.21.1')
            : join(nodeParent, '22.21.1', 'bin')

        if (isWin) {
            process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local'
        }

        mockExistsSync.mockImplementation((p: string) =>
            p === nodeParent || p === newestBin
        )
        mockReaddirSync.mockImplementation((p: string) => {
            if (p === nodeParent) return ['20.11.0', '22.21.1', '18.19.0']
            return []
        })

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).toContain(newestBin)
    })

    it('picks newest mise node version by sort order', () => {
        const nodeParent = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\mise\\installs\\node'
            : join(capturedHome, '.local', 'share', 'mise', 'installs', 'node')

        if (isWin) {
            process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local'
        }

        // After sort().reverse(), '22.21.1' > '20.11.0' > '18.19.0'
        const versions = ['18.19.0', '20.11.0', '22.21.1']
        const expectedNewest = isWin
            ? join(nodeParent, '22.21.1')
            : join(nodeParent, '22.21.1', 'bin')

        mockExistsSync.mockImplementation((p: string) =>
            p === nodeParent || p === expectedNewest
        )
        mockReaddirSync.mockImplementation((p: string) => {
            if (p === nodeParent) return versions
            return []
        })

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).toContain(expectedNewest)
    })

    // -----------------------------------------------------------------------
    // 4. volta / fnm / nvm dirs exist -> PATH prepended correctly
    // -----------------------------------------------------------------------

    it('prepends volta bin dir via VOLTA_HOME', () => {
        const voltaHome = isWin ? 'C:\\volta-custom' : '/opt/volta'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome

        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).toContain(voltaBin)
    })

    it('prepends volta default bin dir when VOLTA_HOME is not set', () => {
        // Default uses the captured home: join(home, '.volta', 'bin')
        const voltaBin = join(capturedHome, '.volta', 'bin')

        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).toContain(voltaBin)
    })

    it('prepends fnm multishell path when FNM_MULTISHELL_PATH is set', () => {
        const fnmDir = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\1234'
            : '/tmp/fnm_multishells/1234'
        process.env.FNM_MULTISHELL_PATH = fnmDir

        mockExistsSync.mockImplementation((p: string) => p === fnmDir)

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).toContain(fnmDir)
    })

    if (isWin) {
        it('prepends NVM_SYMLINK dir when set on Windows', () => {
            const nvmSymlink = 'C:\\Program Files\\nodejs'
            process.env.NVM_SYMLINK = nvmSymlink

            mockExistsSync.mockImplementation((p: string) => p === nvmSymlink)

            enrichProcessPath()

            const entries = (process.env.PATH ?? '').split(SEP)
            expect(entries).toContain(nvmSymlink)
        })
    } else {
        it('prepends nvm node version bin dir on Unix', () => {
            const nvmDir = '/home/testuser/.nvm'
            process.env.NVM_DIR = nvmDir
            const nodeParent = join(nvmDir, 'versions', 'node')
            const newestBin = join(nodeParent, 'v20.11.0', 'bin')

            mockExistsSync.mockImplementation((p: string) =>
                p === nodeParent || p === newestBin
            )
            mockReaddirSync.mockImplementation((p: string) => {
                if (p === nodeParent) return ['v18.19.0', 'v20.11.0']
                return []
            })

            enrichProcessPath()

            const entries = (process.env.PATH ?? '').split(SEP)
            expect(entries).toContain(newestBin)
        })
    }

    // -----------------------------------------------------------------------
    // 5. Only absolute paths added; relative paths rejected
    // -----------------------------------------------------------------------

    it('does not add relative FNM_MULTISHELL_PATH to PATH', () => {
        process.env.FNM_MULTISHELL_PATH = 'relative/fnm/path'

        // existsSync returns true for everything, but the relative path
        // is rejected by the isAbsolute guard in both the collector and
        // the final filter.
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([])

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).not.toContain('relative/fnm/path')
    })

    it('does not add relative MISE_SHIMS_DIR to PATH', () => {
        process.env.MISE_SHIMS_DIR = 'relative/mise/shims'

        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([])

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries).not.toContain('relative/mise/shims')
    })

    // -----------------------------------------------------------------------
    // 6. Idempotent: calling twice doesn't duplicate entries
    // -----------------------------------------------------------------------

    it('does not duplicate entries when called twice', () => {
        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome

        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()
        const afterFirst = process.env.PATH

        enrichProcessPath()
        const afterSecond = process.env.PATH

        expect(afterSecond).toBe(afterFirst)

        // Count occurrences of voltaBin in PATH
        const entries = (afterSecond ?? '').split(SEP)
        const count = entries.filter(e => e === voltaBin).length
        expect(count).toBe(1)
    })

    it('is idempotent with multiple managers present', () => {
        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome

        const fnmDir = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\9999'
            : '/tmp/fnm_multishells/9999'
        process.env.FNM_MULTISHELL_PATH = fnmDir

        mockExistsSync.mockImplementation((p: string) =>
            p === voltaBin || p === fnmDir
        )

        enrichProcessPath()
        const afterFirst = process.env.PATH

        enrichProcessPath()
        expect(process.env.PATH).toBe(afterFirst)
    })

    // -----------------------------------------------------------------------
    // 7. Windows PATH key casing: `Path` key -> enrichment mutates `Path`,
    //    does not create duplicate `PATH` key
    // -----------------------------------------------------------------------

    it('mutates existing Path key instead of creating duplicate PATH', () => {
        // Set up env with `Path` (Windows-style casing) instead of `PATH`
        process.env = {
            Path: '/usr/bin',
            HOME: '/home/testuser',
            USERPROFILE: 'C:\\Users\\testuser',
        }

        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome
        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        // The `Path` key should be updated
        expect(process.env.Path).toContain(voltaBin)

        // No duplicate `PATH` key should have been created
        const keys = Object.keys(process.env).filter(k => k.toLowerCase() === 'path')
        expect(keys).toHaveLength(1)
        expect(keys[0]).toBe('Path')
    })

    // -----------------------------------------------------------------------
    // 8. No PATH-like key -> creates `PATH`
    // -----------------------------------------------------------------------

    it('creates PATH key when no path-like key exists', () => {
        // Set up env without any PATH key
        process.env = {
            HOME: '/home/testuser',
            USERPROFILE: 'C:\\Users\\testuser',
        }

        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome
        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        // A `PATH` key should have been created (pathKey() defaults to 'PATH')
        expect(process.env.PATH).toBeDefined()
        expect(process.env.PATH).toContain(voltaBin)
    })

    it('creates PATH with correct content when no prior PATH key exists', () => {
        process.env = {
            HOME: '/home/testuser',
            USERPROFILE: 'C:\\Users\\testuser',
        }

        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome
        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        // PATH = "<voltaBin><SEP>" (prepended to originally empty string)
        const entries = (process.env.PATH ?? '').split(SEP)
        expect(entries[0]).toBe(voltaBin)
    })

    // -----------------------------------------------------------------------
    // Additional edge cases
    // -----------------------------------------------------------------------

    it('prepends multiple manager dirs in correct order', () => {
        // Use MISE_SHIMS_DIR + VOLTA_HOME to control paths explicitly
        const shimsDir = isWin
            ? 'C:\\custom\\mise\\shims'
            : '/custom/mise/shims'
        process.env.MISE_SHIMS_DIR = shimsDir

        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome

        mockExistsSync.mockImplementation((p: string) =>
            p === shimsDir || p === voltaBin
        )

        enrichProcessPath()

        const entries = (process.env.PATH ?? '').split(SEP)

        // mise is collected first, then volta — both should precede original PATH
        const shimsIdx = entries.indexOf(shimsDir)
        const voltaIdx = entries.indexOf(voltaBin)
        const origIdx = entries.indexOf('/usr/bin')

        expect(shimsIdx).toBeGreaterThanOrEqual(0)
        expect(voltaIdx).toBeGreaterThanOrEqual(0)

        // Both should appear before the original /usr/bin
        expect(shimsIdx).toBeLessThan(origIdx)
        expect(voltaIdx).toBeLessThan(origIdx)

        // mise dirs come before volta (collection order)
        expect(shimsIdx).toBeLessThan(voltaIdx)
    })

    it('skips mise node version dir when readdirSync throws', () => {
        const nodeParent = isWin
            ? 'C:\\Users\\testuser\\AppData\\Local\\mise\\installs\\node'
            : join(capturedHome, '.local', 'share', 'mise', 'installs', 'node')

        if (isWin) {
            process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local'
        }

        mockExistsSync.mockImplementation((p: string) => p === nodeParent)
        mockReaddirSync.mockImplementation(() => {
            throw new Error('EACCES: permission denied')
        })

        const before = process.env.PATH
        enrichProcessPath()
        // PATH should remain unchanged — no crash
        expect(process.env.PATH).toBe(before)
    })

    it('does not add dir that already exists in PATH', () => {
        const voltaHome = isWin ? 'C:\\volta-test' : '/opt/volta-test'
        const voltaBin = join(voltaHome, 'bin')
        process.env.VOLTA_HOME = voltaHome

        // Pre-populate PATH with volta bin
        process.env.PATH = voltaBin + SEP + '/usr/bin'

        mockExistsSync.mockImplementation((p: string) => p === voltaBin)

        enrichProcessPath()

        // Count: should still be exactly 1
        const entries = (process.env.PATH ?? '').split(SEP)
        const count = entries.filter(e => e === voltaBin).length
        expect(count).toBe(1)
    })
})
