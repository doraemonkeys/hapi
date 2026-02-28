import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('alive incremental events', () => {
    afterEach(() => {
        setSystemTime()
    })

    it('includes active=true in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('emits full machine object when reactivating (inactive→active)', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })

    it('emits a patch (not full object) for periodic alive heartbeats', () => {
        const baseTime = Date.now()
        setSystemTime(new Date(baseTime))

        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-heartbeat-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        // First alive: reactivation (inactive→active) — emits full object
        cache.handleMachineAlive({ machineId: machine.id, time: baseTime })
        events.length = 0

        // Advance wall clock past the 10s broadcast throttle
        setSystemTime(new Date(baseTime + 11_000))

        // Second alive: periodic heartbeat — should emit a patch
        cache.handleMachineAlive({ machineId: machine.id, time: baseTime + 11_000 })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        const data = update.data as Record<string, unknown>
        expect(data.active).toBe(true)
        expect(typeof data.activeAt).toBe('number')
        // Patch must NOT contain full machine fields
        expect(data.id).toBeUndefined()
        expect(data.metadata).toBeUndefined()
    })
})
