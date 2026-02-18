import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectPath } from './path'

interface ForkClaudeSessionOptions {
    sourceSessionId: string
    workingDirectory: string
    forkAtUuid: string
    forkAtMessageId?: string
}

interface JsonRecord {
    [key: string]: unknown
}

type SearchForkPointResult =
    | { type: 'found'; records: JsonRecord[] }
    | { type: 'missing-file' }
    | { type: 'not-found' }

function parseLine(rawLine: string, lineNumber: number): JsonRecord {
    let parsed: unknown
    try {
        parsed = JSON.parse(rawLine)
    } catch {
        throw new Error(`Failed to parse JSONL line ${lineNumber}`)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid JSONL object at line ${lineNumber}`)
    }

    return parsed as JsonRecord
}

function rewriteSessionIds(record: JsonRecord, newSessionId: string): JsonRecord {
    const rewritten = { ...record }

    if (typeof rewritten.sessionId === 'string') {
        rewritten.sessionId = newSessionId
    }

    if (typeof rewritten.session_id === 'string') {
        rewritten.session_id = newSessionId
    }

    return rewritten
}

function readMessageId(record: JsonRecord): string | null {
    if (!record.message || typeof record.message !== 'object' || Array.isArray(record.message)) {
        return null
    }
    const id = (record.message as Record<string, unknown>).id
    return typeof id === 'string' ? id : null
}

function matchesForkPoint(record: JsonRecord, opts: { forkAtUuid: string; forkAtMessageId?: string }): boolean {
    if (opts.forkAtUuid.length > 0 && record.uuid === opts.forkAtUuid) {
        return true
    }

    if (!opts.forkAtMessageId || record.type !== 'assistant') {
        return false
    }

    return readMessageId(record) === opts.forkAtMessageId
}

async function findForkPointInFile(sourceFilePath: string, opts: { forkAtUuid: string; forkAtMessageId?: string }): Promise<SearchForkPointResult> {
    let sourceFile: string
    try {
        sourceFile = await readFile(sourceFilePath, 'utf-8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return { type: 'missing-file' }
        }
        throw error
    }

    const copiedRecords: JsonRecord[] = []
    const lines = sourceFile.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index]?.trim()
        if (!rawLine) {
            continue
        }

        const record = parseLine(rawLine, index + 1)
        copiedRecords.push(record)

        if (matchesForkPoint(record, opts)) {
            return {
                type: 'found',
                records: copiedRecords
            }
        }
    }

    return { type: 'not-found' }
}

async function findForkPointInSessionDirectory(
    projectDir: string,
    sourceSessionId: string,
    opts: { forkAtUuid: string; forkAtMessageId?: string }
): Promise<{ records: JsonRecord[] } | null> {
    const preferredSourcePath = join(projectDir, `${sourceSessionId}.jsonl`)
    const preferredSearch = await findForkPointInFile(preferredSourcePath, opts)
    if (preferredSearch.type === 'found') {
        return { records: preferredSearch.records }
    }

    let entries
    try {
        entries = await readdir(projectDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
        if (preferredSearch.type === 'missing-file' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            throw new Error('Session file not found on disk')
        }
        throw error
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
            continue
        }
        if (entry.name === `${sourceSessionId}.jsonl`) {
            continue
        }

        const filePath = join(projectDir, entry.name)
        try {
            const search = await findForkPointInFile(filePath, opts)
            if (search.type === 'found') {
                return { records: search.records }
            }
        } catch {
            continue
        }
    }

    if (preferredSearch.type === 'missing-file') {
        throw new Error('Session file not found on disk')
    }
    return null
}

export async function forkClaudeSession(opts: ForkClaudeSessionOptions): Promise<{ newSessionId: string }> {
    const projectDir = getProjectPath(opts.workingDirectory)

    const searchResult = await findForkPointInSessionDirectory(
        projectDir,
        opts.sourceSessionId,
        {
            forkAtUuid: opts.forkAtUuid,
            forkAtMessageId: opts.forkAtMessageId
        }
    )
    if (!searchResult) {
        throw new Error('Fork point not found in session file')
    }

    const newSessionId = randomUUID()
    const rewrittenLines = searchResult.records.map((record) => JSON.stringify(rewriteSessionIds(record, newSessionId)))
    const newFilePath = join(projectDir, `${newSessionId}.jsonl`)
    const output = `${rewrittenLines.join('\n')}\n`

    await writeFile(newFilePath, output, 'utf-8')

    return { newSessionId }
}
