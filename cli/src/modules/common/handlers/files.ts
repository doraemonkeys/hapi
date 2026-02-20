import { logger } from '@/ui/logger'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, resolve } from 'path'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
}

interface ReadFileResponse {
    success: boolean
    content?: string
    error?: string
}

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)
            const buffer = await readFile(resolvedPath)
            const content = buffer.toString('base64')
            return { success: true, content }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(data.path)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(data.path, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })

    rpcHandlerManager.registerHandler<{ path: string }, { success: boolean; error?: string }>('createFile', async (data) => {
        logger.debug('Create file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)

            // Reject if already exists
            try {
                await stat(resolvedPath)
                return rpcError('A file or folder with that name already exists')
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException
                if (nodeError.code !== 'ENOENT') {
                    throw error
                }
            }

            // Ensure parent directories exist
            await mkdir(dirname(resolvedPath), { recursive: true })
            await writeFile(resolvedPath, '')
            return { success: true }
        } catch (error) {
            logger.debug('Failed to create file:', error)
            return rpcError(getErrorMessage(error, 'Failed to create file'))
        }
    })

    rpcHandlerManager.registerHandler<{ path: string }, { success: boolean; error?: string }>('deleteFile', async (data) => {
        logger.debug('Delete file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)
            await unlink(resolvedPath)
            return { success: true }
        } catch (error) {
            logger.debug('Failed to delete file:', error)
            return rpcError(getErrorMessage(error, 'Failed to delete file'))
        }
    })
}
