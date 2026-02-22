import { describe, expect, it, mock } from 'bun:test'
import { RpcGateway } from './rpcGateway'

describe('RpcGateway forkSession', () => {
    it('forwards optional forkAtMessageId to machine RPC', async () => {
        const gateway = new RpcGateway({} as never, {} as never)
        const machineRpc = mock(async () => ({ type: 'success', sessionId: 'forked-session' }))
        ;(gateway as unknown as { machineRpc: typeof machineRpc }).machineRpc = machineRpc

        const result = await gateway.forkSession('machine-1', {
            agent: 'claude',
            sourceSessionId: 'source-claude-session',
            path: '/repo',
            forkAtUuid: 'uuid-from-hub',
            forkAtMessageId: 'msg_123'
        })

        expect(result).toEqual({ type: 'success', sessionId: 'forked-session' })
        expect(machineRpc).toHaveBeenCalledTimes(1)
        expect(machineRpc).toHaveBeenCalledWith('machine-1', 'fork-session', {
            agent: 'claude',
            sourceSessionId: 'source-claude-session',
            path: '/repo',
            forkAtUuid: 'uuid-from-hub',
            forkAtMessageId: 'msg_123'
        })
    })

    it('forwards codex turn-based fork params to machine RPC', async () => {
        const gateway = new RpcGateway({} as never, {} as never)
        const machineRpc = mock(async () => ({ type: 'success', sessionId: 'forked-codex-session' }))
        ;(gateway as unknown as { machineRpc: typeof machineRpc }).machineRpc = machineRpc

        const result = await gateway.forkSession('machine-1', {
            agent: 'codex',
            sourceThreadId: 'thread-1',
            path: '/repo',
            forkAtTurnId: 'turn-42'
        })

        expect(result).toEqual({ type: 'success', sessionId: 'forked-codex-session' })
        expect(machineRpc).toHaveBeenCalledWith('machine-1', 'fork-session', {
            agent: 'codex',
            sourceThreadId: 'thread-1',
            path: '/repo',
            forkAtTurnId: 'turn-42'
        })
    })
})
