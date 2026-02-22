import { afterEach, describe, expect, it, vi } from 'vitest';
import { forkCodexSession } from './forkSession';
import { CodexAppServerClient } from '../codexAppServerClient';

describe('forkCodexSession', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses fork -> read -> rollback to keep history up to target turn', async () => {
        const callOrder: string[] = [];

        vi.spyOn(CodexAppServerClient.prototype, 'connect').mockImplementation(async () => {
            callOrder.push('connect');
        });
        vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockImplementation(async () => {
            callOrder.push('initialize');
            return {};
        });
        vi.spyOn(CodexAppServerClient.prototype, 'forkThread').mockImplementation(async () => {
            callOrder.push('forkThread');
            return { thread: { id: 'forked-thread' } };
        });
        vi.spyOn(CodexAppServerClient.prototype, 'readThread').mockImplementation(async () => {
            callOrder.push('readThread');
            return {
                thread: {
                    id: 'forked-thread',
                    turns: [{ id: 'turn-1' }, { id: 'turn-2' }, { id: 'turn-3' }]
                }
            };
        });
        const rollbackSpy = vi.spyOn(CodexAppServerClient.prototype, 'rollbackThread').mockImplementation(async () => {
            callOrder.push('rollbackThread');
            return { ok: true };
        });
        vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockImplementation(async () => {
            callOrder.push('disconnect');
        });

        const result = await forkCodexSession({
            sourceThreadId: 'source-thread',
            forkAtTurnId: 'turn-2'
        });

        expect(result).toEqual({ newSessionId: 'forked-thread' });
        expect(rollbackSpy).toHaveBeenCalledWith({
            threadId: 'forked-thread',
            numTurns: 1
        });
        expect(callOrder).toEqual([
            'connect',
            'initialize',
            'forkThread',
            'readThread',
            'rollbackThread',
            'disconnect'
        ]);
    });

    it('skips rollback when target is already the latest turn', async () => {
        vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockResolvedValue({});
        vi.spyOn(CodexAppServerClient.prototype, 'forkThread').mockResolvedValue({ thread: { id: 'forked-thread' } });
        vi.spyOn(CodexAppServerClient.prototype, 'readThread').mockResolvedValue({
            thread: {
                id: 'forked-thread',
                turns: [{ id: 'turn-1' }, { id: 'turn-2' }]
            }
        });
        const rollbackSpy = vi.spyOn(CodexAppServerClient.prototype, 'rollbackThread').mockResolvedValue({ ok: true });
        vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockResolvedValue();

        const result = await forkCodexSession({
            sourceThreadId: 'source-thread',
            forkAtTurnId: 'turn-2'
        });

        expect(result).toEqual({ newSessionId: 'forked-thread' });
        expect(rollbackSpy).not.toHaveBeenCalled();
    });

    it('fails when the target turn does not exist in the forked thread', async () => {
        vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockResolvedValue({});
        vi.spyOn(CodexAppServerClient.prototype, 'forkThread').mockResolvedValue({ thread: { id: 'forked-thread' } });
        vi.spyOn(CodexAppServerClient.prototype, 'readThread').mockResolvedValue({
            thread: {
                id: 'forked-thread',
                turns: [{ id: 'turn-1' }]
            }
        });
        vi.spyOn(CodexAppServerClient.prototype, 'rollbackThread').mockResolvedValue({ ok: true });
        const disconnectSpy = vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockResolvedValue();

        await expect(forkCodexSession({
            sourceThreadId: 'source-thread',
            forkAtTurnId: 'missing-turn'
        })).rejects.toThrow('Fork target turn not found: missing-turn');

        expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
});
