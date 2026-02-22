import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerRenameHandlers } from './rename'

async function createTempDir(prefix: string): Promise<string> {
    const base = tmpdir()
    const path = join(base, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

type RenameResponse = { success: boolean; error?: string }

describe('rename RPC handler', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-rename-handler')
        await mkdir(join(rootDir, 'src'), { recursive: true })
        await mkdir(join(rootDir, 'dest'), { recursive: true })
        await writeFile(join(rootDir, 'src', 'index.ts'), 'console.log("ok")')
        await writeFile(join(rootDir, 'README.md'), '# test')

        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerRenameHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    it('renames a file in the same directory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'README.md', newPath: 'CHANGELOG.md' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(true)

        // Old path gone, new path exists
        await expect(stat(join(rootDir, 'README.md'))).rejects.toThrow()
        const content = await readFile(join(rootDir, 'CHANGELOG.md'), 'utf-8')
        expect(content).toBe('# test')
    })

    it('moves a file to a subdirectory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'README.md', newPath: 'dest/README.md' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(true)

        await expect(stat(join(rootDir, 'README.md'))).rejects.toThrow()
        const content = await readFile(join(rootDir, 'dest', 'README.md'), 'utf-8')
        expect(content).toBe('# test')
    })

    it('renames a directory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'src', newPath: 'lib' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(true)

        await expect(stat(join(rootDir, 'src'))).rejects.toThrow()
        const s = await stat(join(rootDir, 'lib'))
        expect(s.isDirectory()).toBe(true)
        // Children preserved
        const content = await readFile(join(rootDir, 'lib', 'index.ts'), 'utf-8')
        expect(content).toBe('console.log("ok")')
    })

    it('rejects when destination already exists', async () => {
        await writeFile(join(rootDir, 'existing.md'), 'existing')
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'README.md', newPath: 'existing.md' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('already exists')
    })

    it('rejects path traversal outside working directory', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'README.md', newPath: '../../etc/passwd' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('outside')
    })

    it('rejects moving a directory into itself', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'src', newPath: 'src/nested/src' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('into itself')
    })

    it('succeeds as no-op when oldPath equals newPath', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'README.md', newPath: 'README.md' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(true)

        // File still exists
        const content = await readFile(join(rootDir, 'README.md'), 'utf-8')
        expect(content).toBe('# test')
    })

    it('rejects renaming a non-existent source', async () => {
        const response = await rpc.handleRequest({
            method: 'session-test:renameItem',
            params: JSON.stringify({ oldPath: 'nonexistent.txt', newPath: 'something.txt' })
        })
        const parsed = JSON.parse(response) as RenameResponse
        expect(parsed.success).toBe(false)
        expect(parsed.error).toContain('does not exist')
    })
})
