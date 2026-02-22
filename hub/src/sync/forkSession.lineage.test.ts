import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

function createSyncEngine(store: Store): SyncEngine {
    return new SyncEngine(
        store,
        {} as never,
        {} as never,
        { broadcast: () => {} } as never
    )
}

describe('SyncEngine forkSession lineage', () => {
    const engines: SyncEngine[] = []

    afterEach(() => {
        for (const engine of engines) {
            engine.stop()
        }
        engines.length = 0
    })

    it('persists codex mainThreadLineage with source + current thread ids (deduplicated)', async () => {
        const store = new Store(':memory:')
        const engine = createSyncEngine(store)
        engines.push(engine)

        engine.getOrCreateMachine(
            'machine-1',
            { host: 'host-1', platform: 'linux', happyCliVersion: '1.0.0' },
            null,
            'default'
        )
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

        const sourceSession = engine.getOrCreateSession(
            'source-session',
            {
                path: '/repo',
                host: 'host-1',
                flavor: 'codex',
                machineId: 'machine-1',
                codexSessionId: 'thread-new-main'
            },
            null,
            'default'
        )

        const forkedSession = engine.getOrCreateSession(
            'forked-session',
            {
                path: '/repo',
                host: 'host-1',
                flavor: 'codex',
                machineId: 'machine-1',
                codexSessionId: 'thread-new-main',
                mainThreadLineage: ['thread-legacy-main', 'thread-old-main']
            },
            null,
            'default'
        )

        store.messages.addMessage(sourceSession.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    id: 'msg-1',
                    turnId: 'turn-1',
                    thread_id: 'thread-old-main'
                }
            }
        })

        const forkSessionRpc = mock(async () => ({ type: 'success' as const, sessionId: forkedSession.id }))
        ;(engine as unknown as { rpcGateway: { forkSession: typeof forkSessionRpc } }).rpcGateway = {
            forkSession: forkSessionRpc
        }
        const waitForSessionActive = mock(async () => true)
        ;(engine as unknown as { waitForSessionActive: typeof waitForSessionActive }).waitForSessionActive = waitForSessionActive

        const result = await engine.forkSession(sourceSession.id, 1, 'default')
        expect(result).toEqual({ type: 'success', sessionId: forkedSession.id })

        expect(forkSessionRpc).toHaveBeenCalledTimes(1)
        const rpcCalls = (forkSessionRpc as unknown as { mock: { calls: unknown[][] } }).mock.calls
        expect(rpcCalls[0]?.[0]).toBe('machine-1')
        expect(rpcCalls[0]?.[1]).toEqual({
            agent: 'codex',
            sourceThreadId: 'thread-old-main',
            path: '/repo',
            forkAtTurnId: 'turn-1',
            yolo: undefined
        })

        const storedForked = store.sessions.getSessionByNamespace(forkedSession.id, 'default')
        const metadata = (storedForked?.metadata ?? {}) as { [key: string]: unknown }
        expect(metadata.mainThreadLineage).toEqual([
            'thread-legacy-main',
            'thread-old-main',
            'thread-new-main'
        ])
        expect(metadata.forkedFromSessionId).toBe(sourceSession.id)
        expect(metadata.forkedFromMessageSeq).toBe(1)
    })
})
