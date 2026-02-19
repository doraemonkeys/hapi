import { describe, expect, it } from 'bun:test'
import { TerminalRegistry } from './terminalRegistry'

describe('terminal registry', () => {
    it('orphanBySocket keeps terminal alive until attach', () => {
        const registry = new TerminalRegistry({
            idleTimeoutMs: 0,
            keepaliveTimeoutMs: 50
        })
        registry.register('terminal-1', 'session-1', 'socket-1', 'cli-1')

        const orphaned = registry.orphanBySocket('socket-1')
        expect(orphaned).toHaveLength(1)
        expect(registry.countForSocket('socket-1')).toBe(0)
        expect(registry.get('terminal-1')?.orphanedAt).not.toBeNull()

        const attached = registry.attachToSocket('terminal-1', 'session-1', 'socket-2')
        expect('entry' in attached).toBeTrue()
        if ('entry' in attached) {
            expect(attached.entry.socketId).toBe('socket-2')
            expect(attached.entry.orphanedAt).toBeNull()
        }
    })

    it('expires orphaned terminals and records reason as terminal_not_found', async () => {
        let orphanExpiredTerminalId: string | null = null
        const registry = new TerminalRegistry({
            idleTimeoutMs: 0,
            keepaliveTimeoutMs: 10,
            onOrphanExpired: (entry) => {
                orphanExpiredTerminalId = entry.terminalId
            }
        })

        registry.register('terminal-1', 'session-1', 'socket-1', 'cli-1')
        registry.orphanBySocket('socket-1')
        await Bun.sleep(25)

        expect(orphanExpiredTerminalId).not.toBeNull()
        if (orphanExpiredTerminalId === null) {
            return
        }
        expect(orphanExpiredTerminalId === 'terminal-1').toBeTrue()
        expect(registry.get('terminal-1')).toBeNull()
        expect(registry.attachToSocket('terminal-1', 'session-1', 'socket-2')).toEqual({
            error: 'terminal_not_found'
        })
    })

    it('returns cli_disconnected after removeByCliDisconnect', () => {
        const registry = new TerminalRegistry({
            idleTimeoutMs: 0,
            keepaliveTimeoutMs: 50
        })
        registry.register('terminal-1', 'session-1', 'socket-1', 'cli-1')
        registry.orphanBySocket('socket-1')
        registry.removeByCliDisconnect('cli-1')

        expect(registry.attachToSocket('terminal-1', 'session-1', 'socket-2')).toEqual({
            error: 'cli_disconnected'
        })
    })
})
