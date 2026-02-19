import { describe, expect, it } from 'vitest'
import type { Session } from '@hapi/protocol/types'
import type { Machine } from '@/types/api'
import { resolveSessionMachineId, shouldShowWindowsShellPicker } from './terminalPlatform'

type TestSession = {
    machineId?: string
    metadata: {
        os?: string
        machineId?: string
    } | null
}

function makeSession(metadata: TestSession['metadata'], machineId?: string): TestSession {
    return {
        metadata,
        machineId
    }
}

function makeMachine(id: string, platform: string): Machine {
    return {
        id,
        active: true,
        metadata: {
            host: 'dev',
            platform,
            happyCliVersion: '0.0.0'
        }
    }
}

function asSession(value: TestSession): Session {
    return value as unknown as Session
}

describe('terminal platform helpers', () => {
    it('prefers top-level machineId when available', () => {
        const session = makeSession({ machineId: 'from-metadata' }, 'from-session')
        expect(resolveSessionMachineId(asSession(session))).toBe('from-session')
    })

    it('falls back to metadata machineId', () => {
        const session = makeSession({ machineId: 'from-metadata' })
        expect(resolveSessionMachineId(asSession(session))).toBe('from-metadata')
    })

    it('shows picker when session metadata os is win32', () => {
        const session = makeSession({ os: 'win32' })
        expect(shouldShowWindowsShellPicker(asSession(session), [])).toBe(true)
    })

    it('uses machine platform fallback only when session os is missing', () => {
        const windowsMachine = makeMachine('m1', 'win32')
        const unknownSession = makeSession({ machineId: 'm1' })
        const nonWindowsSession = makeSession({ os: 'linux', machineId: 'm1' })

        expect(shouldShowWindowsShellPicker(asSession(unknownSession), [windowsMachine])).toBe(true)
        expect(shouldShowWindowsShellPicker(asSession(nonWindowsSession), [windowsMachine])).toBe(false)
    })

    it('hides picker when fallback machine is missing', () => {
        const session = makeSession({ machineId: 'missing' })
        expect(shouldShowWindowsShellPicker(asSession(session), [])).toBe(false)
    })
})
