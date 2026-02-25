import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SentMessageEntry } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * TanStack Query wrapper for sent message history.
 *
 * Prefetches on composer mount so arrow-key browse has data immediately.
 * staleTime prevents redundant fetches when the history panel opens later.
 * Call invalidate() after sending a message to trigger background refetch.
 */
export function useMessageHistoryQuery(api: ApiClient | null, namespace: string): {
    data: SentMessageEntry[] | undefined
    isLoading: boolean
    error: Error | null
    invalidate(): void
} {
    const queryClient = useQueryClient()

    const query = useQuery({
        queryKey: queryKeys.sentMessages(namespace),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getSentMessages()
        },
        enabled: Boolean(api),
        staleTime: 5 * 60 * 1000,
    })

    const invalidate = useCallback(() => {
        void queryClient.invalidateQueries({
            queryKey: queryKeys.sentMessages(namespace)
        })
    }, [queryClient, namespace])

    return {
        data: query.data?.messages,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error : null,
        invalidate,
    }
}
