import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// ManagedEventSource mock — hoisted so vi.mock factory can reference it.
// ---------------------------------------------------------------------------

const { MockManagedEventSource } = vi.hoisted(() => {
    class MockManagedEventSource {
        static instances: MockManagedEventSource[] = []

        options: {
            urlFactory: (lastEventId: string | null) => string
            tokenFactory: () => string
            handlers: Record<string, unknown>
        }

        closed = false
        reconnectCallCount = 0

        constructor(options: MockManagedEventSource['options']) {
            this.options = options
            MockManagedEventSource.instances.push(this)
        }

        close(): void {
            this.closed = true
        }

        reconnect(): void {
            this.reconnectCallCount++
        }
    }

    return { MockManagedEventSource }
})

vi.mock('@/lib/sseReconnectPolicy', () => ({
    ManagedEventSource: MockManagedEventSource,
}))

vi.mock('@hapi/protocol', () => ({
    isObject: (v: unknown) => v !== null && typeof v === 'object',
}))

vi.mock('@/lib/query-keys', () => ({
    queryKeys: {
        sessions: ['sessions'],
        session: (id: string) => ['sessions', id],
        machines: ['machines'],
    },
}))

vi.mock('@/lib/message-window-store', () => ({
    clearMessageWindow: vi.fn(),
    ingestIncomingMessages: vi.fn(),
}))

// Import after mocking
import { useSSE } from './useSSE'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestInstance(): InstanceType<typeof MockManagedEventSource> {
    return MockManagedEventSource.instances[MockManagedEventSource.instances.length - 1]!
}

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSSE', () => {
    beforeEach(() => {
        MockManagedEventSource.instances = []
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('creates a ManagedEventSource with tokenFactory when enabled', () => {
        const { unmount } = renderHook(
            () =>
                useSSE({
                    enabled: true,
                    token: 'jwt-1',
                    baseUrl: 'http://localhost:3000',
                    onEvent: vi.fn(),
                    getToken: () => 'jwt-live',
                }),
            { wrapper: createWrapper() }
        )

        expect(MockManagedEventSource.instances).toHaveLength(1)
        const inst = latestInstance()

        // tokenFactory should prefer getToken() over the token prop
        expect(inst.options.tokenFactory()).toBe('jwt-live')

        unmount()
    })

    it('tokenFactory falls back to token prop when getToken returns null', () => {
        const { unmount } = renderHook(
            () =>
                useSSE({
                    enabled: true,
                    token: 'jwt-prop',
                    baseUrl: 'http://localhost:3000',
                    onEvent: vi.fn(),
                    getToken: () => null,
                }),
            { wrapper: createWrapper() }
        )

        const inst = latestInstance()
        expect(inst.options.tokenFactory()).toBe('jwt-prop')

        unmount()
    })

    it('URL does not contain token query parameter', () => {
        const { unmount } = renderHook(
            () =>
                useSSE({
                    enabled: true,
                    token: 'secret-jwt',
                    baseUrl: 'http://localhost:3000',
                    onEvent: vi.fn(),
                }),
            { wrapper: createWrapper() }
        )

        const inst = latestInstance()
        const url = inst.options.urlFactory(null)
        expect(url).not.toContain('token=')
        expect(url).toContain('/api/events')

        unmount()
    })

    describe('onunauthorized recovery', () => {
        it('calls refreshAuth on 401, then reconnects on success', async () => {
            const refreshAuth = vi.fn().mockResolvedValue('new-jwt')
            const onDisconnect = vi.fn()

            const { unmount } = renderHook(
                () =>
                    useSSE({
                        enabled: true,
                        token: 'old-jwt',
                        baseUrl: 'http://localhost:3000',
                        onEvent: vi.fn(),
                        onDisconnect,
                        refreshAuth,
                    }),
                { wrapper: createWrapper() }
            )

            const inst = latestInstance()
            const onunauthorized = inst.options.handlers.onunauthorized as () => Promise<void>

            // Simulate 401
            await act(async () => {
                await onunauthorized()
            })

            expect(onDisconnect).toHaveBeenCalledWith('unauthorized')
            expect(refreshAuth).toHaveBeenCalledTimes(1)
            expect(inst.reconnectCallCount).toBe(1)

            unmount()
        })

        it('does NOT reconnect when refreshAuth fails', async () => {
            const refreshAuth = vi.fn().mockResolvedValue(null)
            const onDisconnect = vi.fn()

            const { unmount } = renderHook(
                () =>
                    useSSE({
                        enabled: true,
                        token: 'old-jwt',
                        baseUrl: 'http://localhost:3000',
                        onEvent: vi.fn(),
                        onDisconnect,
                        refreshAuth,
                    }),
                { wrapper: createWrapper() }
            )

            const inst = latestInstance()
            const onunauthorized = inst.options.handlers.onunauthorized as () => Promise<void>

            await act(async () => {
                await onunauthorized()
            })

            expect(onDisconnect).toHaveBeenCalledWith('unauthorized')
            expect(refreshAuth).toHaveBeenCalledTimes(1)
            // No reconnect when refresh returns null
            expect(inst.reconnectCallCount).toBe(0)

            unmount()
        })

        it('does NOT reconnect when no refreshAuth provided', async () => {
            const onDisconnect = vi.fn()

            const { unmount } = renderHook(
                () =>
                    useSSE({
                        enabled: true,
                        token: 'old-jwt',
                        baseUrl: 'http://localhost:3000',
                        onEvent: vi.fn(),
                        onDisconnect,
                        // No refreshAuth provided
                    }),
                { wrapper: createWrapper() }
            )

            const inst = latestInstance()
            const onunauthorized = inst.options.handlers.onunauthorized as () => Promise<void>

            await act(async () => {
                await onunauthorized()
            })

            expect(onDisconnect).toHaveBeenCalledWith('unauthorized')
            expect(inst.reconnectCallCount).toBe(0)

            unmount()
        })
    })

    it('registers sync-reset as a named event', () => {
        const { unmount } = renderHook(
            () =>
                useSSE({
                    enabled: true,
                    token: 'jwt',
                    baseUrl: 'http://localhost:3000',
                    onEvent: vi.fn(),
                }),
            { wrapper: createWrapper() }
        )

        const inst = latestInstance()
        const namedEvents = inst.options.handlers.namedEvents as Record<string, unknown>
        expect(namedEvents).toBeDefined()
        expect(typeof namedEvents['sync-reset']).toBe('function')

        unmount()
    })

    it('does not create ManagedEventSource when disabled', () => {
        const { unmount } = renderHook(
            () =>
                useSSE({
                    enabled: false,
                    token: 'jwt',
                    baseUrl: 'http://localhost:3000',
                    onEvent: vi.fn(),
                }),
            { wrapper: createWrapper() }
        )

        expect(MockManagedEventSource.instances).toHaveLength(0)

        unmount()
    })
})
