import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isObject, toSessionSummary } from '@hapi/protocol'
import type {
    Machine,
    MachinesResponse,
    Session,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    SyncEvent
} from '@/types/api'
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

const INVALIDATION_BATCH_MS = 16

type SessionPatch = Partial<Pick<Session, 'active' | 'thinking' | 'activeAt' | 'updatedAt' | 'permissionMode' | 'modelMode'>>

function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
    if (left.active !== right.active) {
        return left.active ? -1 : 1
    }
    if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
        return right.pendingRequestsCount - left.pendingRequestsCount
    }
    return right.updatedAt - left.updatedAt
}

function hasRecordShape(value: unknown): value is Record<string, unknown> {
    return isObject(value)
}

function isSessionRecord(value: unknown): value is Session {
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.id === 'string'
        && typeof value.active === 'boolean'
        && typeof value.activeAt === 'number'
        && typeof value.updatedAt === 'number'
        && typeof value.thinking === 'boolean'
}

function getSessionPatch(value: unknown): SessionPatch | null {
    if (!hasRecordShape(value)) {
        return null
    }

    const patch: SessionPatch = {}
    let hasKnownPatch = false

    if (typeof value.active === 'boolean') {
        patch.active = value.active
        hasKnownPatch = true
    }
    if (typeof value.thinking === 'boolean') {
        patch.thinking = value.thinking
        hasKnownPatch = true
    }
    if (typeof value.activeAt === 'number') {
        patch.activeAt = value.activeAt
        hasKnownPatch = true
    }
    if (typeof value.updatedAt === 'number') {
        patch.updatedAt = value.updatedAt
        hasKnownPatch = true
    }
    if (typeof value.permissionMode === 'string') {
        patch.permissionMode = value.permissionMode as Session['permissionMode']
        hasKnownPatch = true
    }
    if (typeof value.modelMode === 'string') {
        patch.modelMode = value.modelMode as Session['modelMode']
        hasKnownPatch = true
    }

    return hasKnownPatch ? patch : null
}

function hasUnknownSessionPatchKeys(value: unknown): boolean {
    if (!hasRecordShape(value)) {
        return false
    }
    const knownKeys = new Set(['active', 'thinking', 'activeAt', 'updatedAt', 'permissionMode', 'modelMode'])
    return Object.keys(value).some((key) => !knownKeys.has(key))
}

function isMachineMetadata(value: unknown): value is Machine['metadata'] {
    if (value === null) {
        return true
    }
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.host === 'string'
        && typeof value.platform === 'string'
        && typeof value.happyCliVersion === 'string'
}

function isMachineRecord(value: unknown): value is Machine {
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.id === 'string'
        && typeof value.active === 'boolean'
        && isMachineMetadata(value.metadata)
}

function isInactiveMachinePatch(value: unknown): boolean {
    return hasRecordShape(value) && value.active === false
}

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
    const invalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingInvalidationsRef = useRef<{
        sessions: boolean
        machines: boolean
        sessionIds: Set<string>
    }>({ sessions: false, machines: false, sessionIds: new Set() })
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
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            setSubscriptionId(null)
            return
        }

        setSubscriptionId(null)

        // --- Batched invalidation ---
        const flushInvalidations = () => {
            const pending = pendingInvalidationsRef.current
            if (!pending.sessions && !pending.machines && pending.sessionIds.size === 0) {
                return
            }

            const shouldInvalidateSessions = pending.sessions
            const shouldInvalidateMachines = pending.machines
            const sessionIds = Array.from(pending.sessionIds)

            pending.sessions = false
            pending.machines = false
            pending.sessionIds.clear()

            const tasks: Array<Promise<unknown>> = []
            if (shouldInvalidateSessions) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.sessions }))
            }
            for (const sessionId of sessionIds) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
            }
            if (shouldInvalidateMachines) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.machines }))
            }

            if (tasks.length === 0) {
                return
            }
            void Promise.all(tasks).catch(() => {})
        }

        const scheduleInvalidationFlush = () => {
            if (invalidationTimerRef.current) {
                return
            }
            invalidationTimerRef.current = setTimeout(() => {
                invalidationTimerRef.current = null
                flushInvalidations()
            }, INVALIDATION_BATCH_MS)
        }

        const queueSessionListInvalidation = () => {
            pendingInvalidationsRef.current.sessions = true
            scheduleInvalidationFlush()
        }

        const queueSessionDetailInvalidation = (sessionId: string) => {
            pendingInvalidationsRef.current.sessionIds.add(sessionId)
            scheduleInvalidationFlush()
        }

        const queueMachinesInvalidation = () => {
            pendingInvalidationsRef.current.machines = true
            scheduleInvalidationFlush()
        }

        // --- Optimistic cache patching ---
        const upsertSessionSummary = (session: Session) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const summary = toSessionSummary(session)
                const nextSessions = previous.sessions.slice()
                const existingIndex = nextSessions.findIndex((item) => item.id === session.id)
                if (existingIndex >= 0) {
                    nextSessions[existingIndex] = summary
                } else {
                    nextSessions.push(summary)
                }
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
        }

        const patchSessionSummary = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextSessions = previous.sessions.slice()
                const index = nextSessions.findIndex((item) => item.id === sessionId)
                if (index < 0) {
                    return previous
                }

                const current = nextSessions[index]
                if (!current) {
                    return previous
                }

                const nextSummary: SessionSummary = {
                    ...current,
                    active: patch.active ?? current.active,
                    thinking: patch.thinking ?? current.thinking,
                    activeAt: patch.activeAt ?? current.activeAt,
                    updatedAt: patch.updatedAt ?? current.updatedAt,
                    modelMode: patch.modelMode ?? current.modelMode
                }

                patched = true
                nextSessions[index] = nextSummary
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
            return patched
        }

        const patchSessionDetail = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(sessionId), (previous) => {
                if (!previous?.session) {
                    return previous
                }
                patched = true
                return {
                    ...previous,
                    session: {
                        ...previous.session,
                        ...patch
                    }
                }
            })
            return patched
        }

        const removeSessionSummary = (sessionId: string) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextSessions = previous.sessions.filter((item) => item.id !== sessionId)
                if (nextSessions.length === previous.sessions.length) {
                    return previous
                }
                return { ...previous, sessions: nextSessions }
            })
        }

        const upsertMachine = (machine: Machine) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextMachines = previous.machines.slice()
                const index = nextMachines.findIndex((item) => item.id === machine.id)
                if (!machine.active) {
                    if (index >= 0) {
                        nextMachines.splice(index, 1)
                        return { ...previous, machines: nextMachines }
                    }
                    return previous
                }

                if (index >= 0) {
                    nextMachines[index] = machine
                } else {
                    nextMachines.push(machine)
                }
                return { ...previous, machines: nextMachines }
            })
        }

        const removeMachine = (machineId: string) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextMachines = previous.machines.filter((item) => item.id !== machineId)
                if (nextMachines.length === previous.machines.length) {
                    return previous
                }
                return { ...previous, machines: nextMachines }
            })
        }

        // --- Event handling ---
        const handleSyncEvent = (event: SyncEvent) => {
            if (event.type === 'heartbeat') {
                return
            }

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

                // Cross-device sync: invalidate sent-messages cache when a user
                // message arrives via SSE (e.g. sent from Telegram or another tab)
                const msgContent = event.message.content
                if (isObject(msgContent) && msgContent.role === 'user' && event.namespace) {
                    void queryClient.invalidateQueries({
                        queryKey: queryKeys.sentMessages(event.namespace)
                    })
                }
            }

            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                if (event.type === 'session-removed') {
                    removeSessionSummary(event.sessionId)
                    void queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
                    clearMessageWindow(event.sessionId)
                } else if (isSessionRecord(event.data) && event.data.id === event.sessionId) {
                    queryClient.setQueryData<SessionResponse>(queryKeys.session(event.sessionId), { session: event.data })
                    upsertSessionSummary(event.data)
                } else {
                    const patch = getSessionPatch(event.data)
                    if (patch) {
                        const detailPatched = patchSessionDetail(event.sessionId, patch)
                        const summaryPatched = patchSessionSummary(event.sessionId, patch)

                        if (!detailPatched) {
                            queueSessionDetailInvalidation(event.sessionId)
                        }
                        if (!summaryPatched) {
                            queueSessionListInvalidation()
                        }
                        if (hasUnknownSessionPatchKeys(event.data)) {
                            queueSessionDetailInvalidation(event.sessionId)
                            queueSessionListInvalidation()
                        }
                    } else {
                        queueSessionDetailInvalidation(event.sessionId)
                        queueSessionListInvalidation()
                    }
                }
            }

            if (event.type === 'machine-updated') {
                if (isMachineRecord(event.data)) {
                    upsertMachine(event.data)
                } else if (event.data === null || isInactiveMachinePatch(event.data)) {
                    removeMachine(event.machineId)
                } else if (!hasRecordShape(event.data) || typeof event.data.activeAt !== 'number') {
                    queueMachinesInvalidation()
                }
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
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            managed.close()
            if (managedRef.current === managed) {
                managedRef.current = null
            }
            setSubscriptionId(null)
        }
    }, [options.baseUrl, options.enabled, options.token, subscriptionKey, queryClient])

    return { subscriptionId }
}
