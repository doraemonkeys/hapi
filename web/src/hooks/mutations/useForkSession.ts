import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

type ForkInput = {
    sessionId: string
    messageSeq: number
}

type ForkResult = {
    sessionId: string
}

export function useForkSession(api: ApiClient | null): {
    forkSession: (input: ForkInput) => Promise<ForkResult>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const mutation = useMutation({
        mutationFn: async (input: ForkInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.forkSession(input.sessionId, input.messageSeq)
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        forkSession: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : mutation.error ? 'Failed to fork session' : null
    }
}
