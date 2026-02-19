import type { Session } from '@hapi/protocol/types'
import type { Machine } from '@/types/api'

type SessionWithMachineId = Session & {
    machineId?: string
}

function readTopLevelMachineId(session: SessionWithMachineId): string | null {
    if (typeof session.machineId !== 'string' || session.machineId.length === 0) {
        return null
    }
    return session.machineId
}

export function resolveSessionMachineId(session: Session | null | undefined): string | null {
    if (!session) {
        return null
    }
    const topLevelMachineId = readTopLevelMachineId(session as SessionWithMachineId)
    if (topLevelMachineId) {
        return topLevelMachineId
    }
    const metadataMachineId = session.metadata?.machineId
    if (typeof metadataMachineId !== 'string' || metadataMachineId.length === 0) {
        return null
    }
    return metadataMachineId
}

export function shouldShowWindowsShellPicker(session: Session | null | undefined, machines: Machine[]): boolean {
    const sessionOs = session?.metadata?.os
    if (sessionOs === 'win32') {
        return true
    }
    if (typeof sessionOs === 'string' && sessionOs.length > 0) {
        return false
    }
    const machineId = resolveSessionMachineId(session)
    if (!machineId) {
        return false
    }
    const machine = machines.find(item => item.id === machineId)
    return machine?.metadata?.platform === 'win32'
}
