import { describe, expect, it, vi } from 'vitest'
import { ApiMachineClient } from './apiMachine'
import type { Machine } from './types'
import type { ForkSessionOptions, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0
    }
}

describe('ApiMachineClient fork-session RPC handler', () => {
    it('registers and forwards fork-session params', async () => {
        const machine = createMachine('machine-test')
        const client = new ApiMachineClient('token', machine)
        const forkSession = vi.fn(async (_options: ForkSessionOptions) => ({
            type: 'success' as const,
            sessionId: 'new-hapi-session'
        }))

        client.setRPCHandlers({
            spawnSession: async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({ type: 'error', errorMessage: 'unused' }),
            stopSession: () => true,
            requestShutdown: () => undefined,
            forkSession
        })

        const rpcHandlerManager = (client as unknown as { rpcHandlerManager: { handleRequest: (request: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
        const response = await rpcHandlerManager.handleRequest({
            method: `${machine.id}:fork-session`,
            params: JSON.stringify({
                sourceSessionId: 'claude-source',
                path: '/repo/path',
                forkAtUuid: 'uuid-target',
                forkAtMessageId: 'msg_abc123',
                agent: 'claude',
                model: 'claude-sonnet-4'
            })
        })

        expect(JSON.parse(response)).toEqual({ type: 'success', sessionId: 'new-hapi-session' })
        expect(forkSession).toHaveBeenCalledTimes(1)
        expect(forkSession).toHaveBeenCalledWith({
            sourceSessionId: 'claude-source',
            path: '/repo/path',
            forkAtUuid: 'uuid-target',
            forkAtMessageId: 'msg_abc123',
            agent: 'claude',
            model: 'claude-sonnet-4'
        })
    })

    it('returns RPC error when fork-session validation fails', async () => {
        const machine = createMachine('machine-test')
        const client = new ApiMachineClient('token', machine)

        client.setRPCHandlers({
            spawnSession: async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({ type: 'error', errorMessage: 'unused' }),
            stopSession: () => true,
            requestShutdown: () => undefined,
            forkSession: async (_options: ForkSessionOptions) => ({ type: 'success', sessionId: 'unused' })
        })

        const rpcHandlerManager = (client as unknown as { rpcHandlerManager: { handleRequest: (request: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
        const response = await rpcHandlerManager.handleRequest({
            method: `${machine.id}:fork-session`,
            params: JSON.stringify({
                sourceSessionId: 'claude-source',
                path: '/repo/path'
            })
        })

        expect(JSON.parse(response)).toEqual({ error: 'Fork point UUID is required' })
    })

    it('accepts codex fork requests without Claude UUID', async () => {
        const machine = createMachine('machine-test')
        const client = new ApiMachineClient('token', machine)
        const forkSession = vi.fn(async (_options: ForkSessionOptions) => ({
            type: 'success' as const,
            sessionId: 'forked-codex-session'
        }))

        client.setRPCHandlers({
            spawnSession: async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({ type: 'error', errorMessage: 'unused' }),
            stopSession: () => true,
            requestShutdown: () => undefined,
            forkSession
        })

        const rpcHandlerManager = (client as unknown as { rpcHandlerManager: { handleRequest: (request: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
        const response = await rpcHandlerManager.handleRequest({
            method: `${machine.id}:fork-session`,
            params: JSON.stringify({
                agent: 'codex',
                sourceThreadId: 'thread-source',
                forkAtTurnId: 'turn-123',
                path: '/repo/path'
            })
        })

        expect(JSON.parse(response)).toEqual({ type: 'success', sessionId: 'forked-codex-session' })
        expect(forkSession).toHaveBeenCalledWith({
            agent: 'codex',
            sourceThreadId: 'thread-source',
            forkAtTurnId: 'turn-123',
            path: '/repo/path',
            model: undefined,
            yolo: undefined,
            sessionType: undefined,
            worktreeName: undefined
        })
    })
})
