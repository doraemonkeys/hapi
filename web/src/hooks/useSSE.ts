import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isObject } from '@hapi/protocol'
import type { SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow, ingestIncomingMessages } from '@/lib/message-window-store'
import { ManagedEventSource } from '@/lib/sseReconnectPolicy'

type SSESubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

type VisibilityState = 'visible' | 'hidden'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

function buildEventsUrl(
    baseUrl: string,
    subscription: SSESubscription,
    visibility: VisibilityState
): string {
    const params = new URLSearchParams()
    params.set('visibility', visibility)
    if (subscription.all) {
        params.set('all', 'true')
    }
    if (subscription.sessionId) {
        params.set('sessionId', subscription.sessionId)
    }
    if (subscription.machineId) {
        params.set('machineId', subscription.machineId)
    }

    const path = `/api/events?${params.toString()}`
    try {
        return new URL(path, baseUrl).toString()
    } catch {
        return path
    }
}

export function useSSE(options: {
    enabled: boolean
    token: string
    baseUrl: string
    subscription?: SSESubscription
    onEvent: (event: SyncEvent) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: unknown) => void
    onToast?: (event: ToastEvent) => void
    /** Returns the current JWT; called on every SSE connection attempt. */
    getToken?: () => string | null
    /** Attempt to refresh the JWT. Returns the new token on success, null on failure. */
    refreshAuth?: () => Promise<string | null>
}): { subscriptionId: string | null } {
    const queryClient = useQueryClient()
    const onEventRef = useRef(options.onEvent)
    const onConnectRef = useRef(options.onConnect)
    const onDisconnectRef = useRef(options.onDisconnect)
    const onErrorRef = useRef(options.onError)
    const onToastRef = useRef(options.onToast)
    const getTokenRef = useRef(options.getToken)
    const refreshAuthRef = useRef(options.refreshAuth)
    const managedRef = useRef<ManagedEventSource | null>(null)
    const [subscriptionId, setSubscriptionId] = useState<string | null>(null)

    useEffect(() => {
        onEventRef.current = options.onEvent
    }, [options.onEvent])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        onConnectRef.current = options.onConnect
    }, [options.onConnect])

    useEffect(() => {
        onDisconnectRef.current = options.onDisconnect
    }, [options.onDisconnect])

    useEffect(() => {
        onToastRef.current = options.onToast
    }, [options.onToast])

    useEffect(() => {
        getTokenRef.current = options.getToken
    }, [options.getToken])

    useEffect(() => {
        refreshAuthRef.current = options.refreshAuth
    }, [options.refreshAuth])

    const subscription = options.subscription ?? {}

    const subscriptionKey = useMemo(() => {
        return `${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
    }, [subscription.all, subscription.sessionId, subscription.machineId])

    useEffect(() => {
        if (!options.enabled) {
            managedRef.current?.close()
            managedRef.current = null
            setSubscriptionId(null)
            return
        }

        setSubscriptionId(null)

        const handleSyncEvent = (event: SyncEvent) => {
            if (event.type === 'connection-changed') {
                const data = event.data
                if (data && typeof data === 'object' && 'subscriptionId' in data) {
                    const nextId = (data as { subscriptionId?: unknown }).subscriptionId
                    if (typeof nextId === 'string' && nextId.length > 0) {
                        setSubscriptionId(nextId)
                    }
                }
            }

            if (event.type === 'toast') {
                onToastRef.current?.(event)
                return
            }

            if (event.type === 'message-received') {
                ingestIncomingMessages(event.sessionId, [event.message])
            }

            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if ('sessionId' in event) {
                    if (event.type === 'session-removed') {
                        void queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
                        clearMessageWindow(event.sessionId)
                    } else {
                        void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) })
                    }
                }
            }

            if (event.type === 'machine-updated') {
                void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
            }

            onEventRef.current(event)
        }

        const handleMessage = (message: { data: string; event: string; id?: string }) => {
            if (typeof message.data !== 'string') {
                return
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(message.data)
            } catch {
                return
            }

            if (!isObject(parsed)) {
                return
            }
            if (typeof parsed.type !== 'string') {
                return
            }

            handleSyncEvent(parsed as SyncEvent)
        }

        /**
         * Handle `sync-reset` named event from hub. This fires when the
         * server's ring buffer no longer contains events since our
         * Last-Event-ID, signaling that a full state refetch is needed.
         */
        const handleSyncReset = () => {
            void queryClient.invalidateQueries()
        }

        // Capture stable subscription values for the URL factory closure
        const sub = {
            ...subscription,
            sessionId: subscription.sessionId ?? undefined,
        }

        const managed = new ManagedEventSource({
            urlFactory: (lastEventId) => {
                const url = buildEventsUrl(
                    options.baseUrl,
                    sub,
                    getVisibilityState()
                )
                return lastEventId ? `${url}&lastEventId=${encodeURIComponent(lastEventId)}` : url
            },
            tokenFactory: () => {
                // Prefer the live getter (tracks refreshed tokens); fall back to prop
                const live = getTokenRef.current?.()
                return live ?? options.token
            },
            handlers: {
                onmessage: handleMessage,
                onopen: () => {
                    onConnectRef.current?.()
                },
                onerror: () => {
                    onErrorRef.current?.(new Error('SSE connection error'))
                    onDisconnectRef.current?.('error')
                },
                onunauthorized: async () => {
                    onDisconnectRef.current?.('unauthorized')
                    const refreshed = await refreshAuthRef.current?.()
                    if (refreshed) {
                        // tokenFactory will pick up the new token on next open()
                        managed.reconnect()
                    }
                    // refresh failed: do not reconnect — user must re-authenticate
                },
                namedEvents: {
                    'sync-reset': handleSyncReset,
                },
            },
        })
        managedRef.current = managed

        return () => {
            managed.close()
            if (managedRef.current === managed) {
                managedRef.current = null
            }
            setSubscriptionId(null)
        }
    }, [options.baseUrl, options.enabled, options.token, subscriptionKey, queryClient])

    return { subscriptionId }
}
