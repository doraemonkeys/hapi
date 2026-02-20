import { getDisplayTitle } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'

export function getSessionName(session: Session): string {
    return getDisplayTitle(session.metadata, session.id)
}

export function getAgentName(session: Session): string {
    const flavor = session.metadata?.flavor
    if (flavor === 'claude') return 'Claude'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'gemini') return 'Gemini'
    if (flavor === 'opencode') return 'OpenCode'
    return 'Agent'
}
