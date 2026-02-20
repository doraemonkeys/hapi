import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useFileOperations(
    api: ApiClient | null,
    sessionId: string | null
): {
    createFile: (parentPath: string, name: string) => Promise<void>
    createFolder: (parentPath: string, name: string) => Promise<void>
    deleteFile: (path: string) => Promise<void>
    deleteFolder: (path: string) => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const invalidateParent = async (parentPath: string) => {
        if (!sessionId) return
        await queryClient.invalidateQueries({
            queryKey: queryKeys.sessionDirectory(sessionId, parentPath)
        })
        await queryClient.invalidateQueries({
            queryKey: queryKeys.gitStatus(sessionId)
        })
    }

    const createFileMutation = useMutation({
        mutationFn: async ({ parentPath, name }: { parentPath: string; name: string }) => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            const fullPath = parentPath ? `${parentPath}/${name}` : name
            const result = await api.createFile(sessionId, fullPath)
            if (!result.success) throw new Error(result.error ?? 'Failed to create file')
        },
        onSuccess: (_data, variables) => void invalidateParent(variables.parentPath),
    })

    const createFolderMutation = useMutation({
        mutationFn: async ({ parentPath, name }: { parentPath: string; name: string }) => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            const fullPath = parentPath ? `${parentPath}/${name}` : name
            const result = await api.createDirectory(sessionId, fullPath)
            if (!result.success) throw new Error(result.error ?? 'Failed to create folder')
        },
        onSuccess: (_data, variables) => void invalidateParent(variables.parentPath),
    })

    const deleteFileMutation = useMutation({
        mutationFn: async ({ path }: { path: string }) => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            const result = await api.deleteFile(sessionId, path)
            if (!result.success) throw new Error(result.error ?? 'Failed to delete file')
        },
        onSuccess: (_data, variables) => {
            const parts = variables.path.split('/')
            const parentPath = parts.slice(0, -1).join('/')
            void invalidateParent(parentPath)
        },
    })

    const deleteFolderMutation = useMutation({
        mutationFn: async ({ path }: { path: string }) => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            const result = await api.deleteDirectory(sessionId, path)
            if (!result.success) throw new Error(result.error ?? 'Failed to delete folder')
        },
        onSuccess: (_data, variables) => {
            const parts = variables.path.split('/')
            const parentPath = parts.slice(0, -1).join('/')
            void invalidateParent(parentPath)
        },
    })

    return {
        createFile: (parentPath, name) => createFileMutation.mutateAsync({ parentPath, name }),
        createFolder: (parentPath, name) => createFolderMutation.mutateAsync({ parentPath, name }),
        deleteFile: (path) => deleteFileMutation.mutateAsync({ path }),
        deleteFolder: (path) => deleteFolderMutation.mutateAsync({ path }),
        isPending: createFileMutation.isPending
            || createFolderMutation.isPending
            || deleteFileMutation.isPending
            || deleteFolderMutation.isPending,
    }
}
