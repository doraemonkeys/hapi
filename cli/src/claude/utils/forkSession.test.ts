import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkClaudeSession } from './forkSession'
import { getProjectPath } from './path'

describe('forkClaudeSession', () => {
    let tempRoot = ''
    let workingDirectory = ''
    let projectDir = ''
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'fork-session-test-'))
        workingDirectory = join(tempRoot, 'repo')
        await mkdir(workingDirectory, { recursive: true })

        process.env.CLAUDE_CONFIG_DIR = join(tempRoot, '.claude')
        projectDir = getProjectPath(workingDirectory)
        await mkdir(projectDir, { recursive: true })
    })

    afterEach(async () => {
        if (originalClaudeConfigDir) {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        } else {
            delete process.env.CLAUDE_CONFIG_DIR
        }

        if (existsSync(tempRoot)) {
            await rm(tempRoot, { recursive: true, force: true })
        }
    })

    it('copies lines through the fork uuid and rewrites sessionId', async () => {
        const sourceSessionId = 'source-session'
        const sourcePath = join(projectDir, `${sourceSessionId}.jsonl`)
        const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')

        await writeFile(sourcePath, fixture, 'utf-8')

        const { newSessionId } = await forkClaudeSession({
            sourceSessionId,
            workingDirectory,
            forkAtUuid: '523a67c0-a9bf-4cef-b886-d71f390b5a2f'
        })

        const forkedContent = await readFile(join(projectDir, `${newSessionId}.jsonl`), 'utf-8')
        const forkedLines = forkedContent.trim().split('\n')
        expect(forkedLines).toHaveLength(1)

        const firstLine = JSON.parse(forkedLines[0]) as { uuid: string; sessionId: string }
        expect(firstLine.uuid).toBe('523a67c0-a9bf-4cef-b886-d71f390b5a2f')
        expect(firstLine.sessionId).toBe(newSessionId)

        const originalContent = await readFile(sourcePath, 'utf-8')
        expect(originalContent).toBe(fixture)
    })

    it('rewrites both sessionId and session_id fields', async () => {
        const sourceSessionId = 'source-session'
        const sourcePath = join(projectDir, `${sourceSessionId}.jsonl`)
        const sourceLines = [
            JSON.stringify({ type: 'system', uuid: 'system-uuid', sessionId: 'old-session', session_id: 'old-session' }),
            JSON.stringify({ type: 'user', uuid: 'fork-point', sessionId: 'old-session', message: { role: 'user', content: 'hello' } }),
            JSON.stringify({ type: 'assistant', uuid: 'after-fork', sessionId: 'old-session' })
        ]

        await writeFile(sourcePath, `${sourceLines.join('\n')}\n`, 'utf-8')

        const { newSessionId } = await forkClaudeSession({
            sourceSessionId,
            workingDirectory,
            forkAtUuid: 'fork-point'
        })

        const forkedContent = await readFile(join(projectDir, `${newSessionId}.jsonl`), 'utf-8')
        const parsed = forkedContent.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(parsed).toHaveLength(2)
        expect(parsed[0].sessionId).toBe(newSessionId)
        expect(parsed[0].session_id).toBe(newSessionId)
        expect(parsed[1].sessionId).toBe(newSessionId)
        expect(parsed[1].uuid).toBe('fork-point')
    })

    it('falls back to assistant message.id when uuid does not match JSONL', async () => {
        const sourceSessionId = 'source-session'
        const sourcePath = join(projectDir, `${sourceSessionId}.jsonl`)
        const sourceLines = [
            JSON.stringify({ type: 'user', uuid: 'user-uuid', sessionId: 'old-session' }),
            JSON.stringify({ type: 'assistant', uuid: 'jsonl-uuid', sessionId: 'old-session', message: { id: 'msg_target' } }),
            JSON.stringify({ type: 'assistant', uuid: 'after-fork', sessionId: 'old-session', message: { id: 'msg_after' } })
        ]

        await writeFile(sourcePath, `${sourceLines.join('\n')}\n`, 'utf-8')

        const { newSessionId } = await forkClaudeSession({
            sourceSessionId,
            workingDirectory,
            forkAtUuid: 'hub-uuid-that-does-not-exist',
            forkAtMessageId: 'msg_target'
        })

        const forkedContent = await readFile(join(projectDir, `${newSessionId}.jsonl`), 'utf-8')
        const parsed = forkedContent.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(parsed).toHaveLength(2)
        expect(parsed[1].uuid).toBe('jsonl-uuid')
        expect((parsed[1].message as { id: string }).id).toBe('msg_target')
        expect(parsed[0].sessionId).toBe(newSessionId)
        expect(parsed[1].sessionId).toBe(newSessionId)
    })

    it('throws when the source jsonl file is missing', async () => {
        await expect(forkClaudeSession({
            sourceSessionId: 'missing-session',
            workingDirectory,
            forkAtUuid: 'missing-uuid'
        })).rejects.toThrow('Session file not found on disk')
    })

    it('throws when the fork uuid does not exist in source file', async () => {
        const sourceSessionId = 'source-session'
        const sourcePath = join(projectDir, `${sourceSessionId}.jsonl`)
        await writeFile(sourcePath, `${JSON.stringify({ type: 'user', uuid: 'other-uuid', sessionId: sourceSessionId })}\n`, 'utf-8')

        await expect(forkClaudeSession({
            sourceSessionId,
            workingDirectory,
            forkAtUuid: 'missing-uuid'
        })).rejects.toThrow('Fork point not found in session file')
    })

    it('falls back to another session file when merged history uuid is not in preferred file', async () => {
        const preferredSourceSessionId = 'newer-session'
        const preferredSourcePath = join(projectDir, `${preferredSourceSessionId}.jsonl`)
        const historicalSourceSessionId = 'older-session'
        const historicalSourcePath = join(projectDir, `${historicalSourceSessionId}.jsonl`)

        await writeFile(
            preferredSourcePath,
            `${JSON.stringify({ type: 'assistant', uuid: 'latest-uuid', sessionId: preferredSourceSessionId })}\n`,
            'utf-8'
        )
        await writeFile(
            historicalSourcePath,
            [
                JSON.stringify({ type: 'user', uuid: 'history-user', sessionId: historicalSourceSessionId }),
                JSON.stringify({ type: 'assistant', uuid: 'history-assistant', sessionId: historicalSourceSessionId })
            ].join('\n') + '\n',
            'utf-8'
        )

        const { newSessionId } = await forkClaudeSession({
            sourceSessionId: preferredSourceSessionId,
            workingDirectory,
            forkAtUuid: 'history-assistant'
        })

        const forkedContent = await readFile(join(projectDir, `${newSessionId}.jsonl`), 'utf-8')
        const parsed = forkedContent.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(parsed).toHaveLength(2)
        expect(parsed[0].uuid).toBe('history-user')
        expect(parsed[1].uuid).toBe('history-assistant')
        expect(parsed[0].sessionId).toBe(newSessionId)
        expect(parsed[1].sessionId).toBe(newSessionId)
    })

    it('falls back when preferred source file is missing but fork uuid exists in another file', async () => {
        const preferredSourceSessionId = 'missing-session'
        const historicalSourceSessionId = 'older-session'
        const historicalSourcePath = join(projectDir, `${historicalSourceSessionId}.jsonl`)

        await writeFile(
            historicalSourcePath,
            `${JSON.stringify({ type: 'assistant', uuid: 'history-assistant', sessionId: historicalSourceSessionId })}\n`,
            'utf-8'
        )

        const { newSessionId } = await forkClaudeSession({
            sourceSessionId: preferredSourceSessionId,
            workingDirectory,
            forkAtUuid: 'history-assistant'
        })

        const forkedContent = await readFile(join(projectDir, `${newSessionId}.jsonl`), 'utf-8')
        const parsed = JSON.parse(forkedContent.trim()) as Record<string, unknown>

        expect(parsed.uuid).toBe('history-assistant')
        expect(parsed.sessionId).toBe(newSessionId)
    })
})
