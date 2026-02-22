import { logger } from '@/ui/logger'
import { rename, stat } from 'fs/promises'
import { resolve, sep } from 'path'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface RenameItemRequest {
    oldPath: string
    newPath: string
}

export function registerRenameHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<RenameItemRequest, { success: boolean; error?: string }>('renameItem', async (data) => {
        logger.debug('Rename item request:', data.oldPath, '->', data.newPath)

        const oldValidation = validatePath(data.oldPath, workingDirectory)
        if (!oldValidation.valid) {
            return rpcError(oldValidation.error ?? 'Invalid source path')
        }

        const newValidation = validatePath(data.newPath, workingDirectory)
        if (!newValidation.valid) {
            return rpcError(newValidation.error ?? 'Invalid destination path')
        }

        try {
            const resolvedOld = resolve(workingDirectory, data.oldPath)
            const resolvedNew = resolve(workingDirectory, data.newPath)

            // Prevent renaming the project root
            if (resolvedOld === workingDirectory || resolvedOld === workingDirectory + sep) {
                return rpcError('Cannot rename the project root directory')
            }

            // No-op: same path
            if (resolvedOld === resolvedNew) {
                return { success: true }
            }

            // Guard: moving a directory into itself
            if (resolvedNew.startsWith(resolvedOld + sep)) {
                return rpcError('Cannot move a directory into itself')
            }

            // Source must exist
            try {
                await stat(resolvedOld)
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException
                if (nodeError.code === 'ENOENT') {
                    return rpcError('Source file or folder does not exist')
                }
                throw error
            }

            // Destination must not already exist
            try {
                await stat(resolvedNew)
                return rpcError('A file or folder with that name already exists at the destination')
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException
                if (nodeError.code !== 'ENOENT') {
                    throw error
                }
                // ENOENT is expected — destination does not exist
            }

            await rename(resolvedOld, resolvedNew)
            return { success: true }
        } catch (error) {
            logger.debug('Failed to rename item:', error)
            return rpcError(getErrorMessage(error, 'Failed to rename item'))
        }
    })
}
