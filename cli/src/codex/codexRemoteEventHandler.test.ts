import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexRemoteEventHandler } from './codexRemoteEventHandler';
import { CodexActiveCallTracker } from './codexRemoteLauncherCollaborative';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';

vi.mock('node:crypto', () => ({
    randomUUID: vi.fn(() => 'test-uuid')
}));

function buildArgs(overrides: Record<string, unknown> = {}) {
    const session = {
        sendCodexMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        thinking: false,
        onThinkingChange: vi.fn(),
        onSessionFound: vi.fn()
    };
    const messageBuffer = { addMessage: vi.fn() };
    const callTracker = new CodexActiveCallTracker(() => 100);
    const reasoningProcessor = new ReasoningProcessor(vi.fn());
    const diffProcessor = new DiffProcessor(vi.fn());
    const sendReady = vi.fn();
    const onTurnSettled = vi.fn();
    const scheduleReadyAfterTurn = vi.fn();

    let currentThreadId: string | null = null;
    let currentTurnId: string | null = null;
    let turnInFlight = false;
    let allowAnonymous = false;

    const state = {
        getCurrentThreadId: () => currentThreadId,
        setCurrentThreadId: (id: string | null) => { currentThreadId = id; },
        getCurrentTurnId: () => currentTurnId,
        setCurrentTurnId: (id: string | null) => { currentTurnId = id; },
        setTurnInFlight: (v: boolean) => { turnInFlight = v; },
        getTurnInFlight: () => turnInFlight,
        getAllowAnonymousTerminalEvent: () => allowAnonymous,
        setAllowAnonymousTerminalEvent: (v: boolean) => { allowAnonymous = v; },
        hasReadyTimer: () => false,
        ...overrides.state as Record<string, unknown> ?? {}
    };

    const args = {
        session: session as any,
        messageBuffer: messageBuffer as any,
        useAppServer: (overrides.useAppServer as boolean) ?? false,
        callTracker,
        reasoningProcessor,
        diffProcessor,
        cleanupTimedOutCallsAtTurnEnd: vi.fn(),
        sendReady,
        onTurnSettled,
        state,
        scheduleReadyAfterTurn,
        ...overrides
    };

    return {
        ...args,
        handle: createCodexRemoteEventHandler(args as any)
    };
}

describe('createCodexRemoteEventHandler', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('mcp_tool_call forwarding', () => {
        it('forwards mcp_tool_call_begin as tool-call message', () => {
            const { handle, session } = buildArgs();

            handle({
                type: 'mcp_tool_call_begin',
                call_id: 'mcp-1',
                invocation: {
                    server: 'my-server',
                    tool: 'my-tool',
                    arguments: { key: 'value' }
                }
            });

            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'tool-call',
                name: 'mcp__my-server__my-tool',
                callId: 'mcp-1',
                input: { key: 'value' }
            }));
        });

        it('forwards mcp_tool_call_end as tool-call-result', () => {
            const { handle, session } = buildArgs();

            handle({
                type: 'mcp_tool_call_end',
                call_id: 'mcp-1',
                result: 'some output'
            });

            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'tool-call-result',
                callId: 'mcp-1',
                output: 'some output',
                is_error: false
            }));
        });

        it('extracts Err from result record and marks as error', () => {
            const { handle, session } = buildArgs();

            handle({
                type: 'mcp_tool_call_end',
                call_id: 'mcp-2',
                result: { Err: 'something went wrong' }
            });

            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'tool-call-result',
                callId: 'mcp-2',
                output: 'something went wrong',
                is_error: true
            }));
        });

        it('extracts Ok from result record', () => {
            const { handle, session } = buildArgs();

            handle({
                type: 'mcp_tool_call_end',
                call_id: 'mcp-3',
                result: { Ok: { data: 'success' } }
            });

            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'tool-call-result',
                callId: 'mcp-3',
                output: { data: 'success' },
                is_error: false
            }));
        });

        it('propagates thread_id and turnId on mcp_tool_call messages', () => {
            const { handle, session, state } = buildArgs();
            state.setCurrentTurnId('turn-42');

            handle({
                type: 'mcp_tool_call_begin',
                call_id: 'mcp-4',
                thread_id: 'thread-7',
                invocation: {
                    server: 'srv',
                    tool: 'fn',
                    arguments: {}
                }
            });

            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
                thread_id: 'thread-7',
                turnId: 'turn-42'
            }));
        });

        it('skips mcp_tool_call_begin when server or tool is missing', () => {
            const { handle, session } = buildArgs();

            handle({
                type: 'mcp_tool_call_begin',
                call_id: 'mcp-5',
                invocation: { server: 'srv' }
            });

            expect(session.sendCodexMessage).not.toHaveBeenCalled();
        });
    });

    describe('terminal event guard', () => {
        it('ignores stale terminal events in appServer mode', () => {
            const { handle, state, onTurnSettled, sendReady } = buildArgs({ useAppServer: true });

            state.setCurrentTurnId('turn-active');

            handle({ type: 'task_complete', turn_id: 'turn-old' });

            // Should be ignored — stale turn_id doesn't match active
            expect(onTurnSettled).not.toHaveBeenCalled();
            expect(sendReady).not.toHaveBeenCalled();
        });

        it('passes matching terminal events through', () => {
            const { handle, state, onTurnSettled } = buildArgs({ useAppServer: true });

            state.setCurrentTurnId('turn-active');

            handle({ type: 'task_complete', turn_id: 'turn-active' });

            expect(onTurnSettled).toHaveBeenCalled();
        });

        it('does not guard terminal events in non-appServer mode', () => {
            const { handle, state, onTurnSettled, sendReady } = buildArgs({ useAppServer: false });

            state.setCurrentTurnId('turn-active');

            handle({ type: 'task_complete', turn_id: 'turn-old' });

            expect(onTurnSettled).toHaveBeenCalled();
            expect(sendReady).toHaveBeenCalled();
        });
    });

    describe('ready debounce', () => {
        it('schedules ready after terminal event when turnInFlight is false', () => {
            const { handle, state, scheduleReadyAfterTurn } = buildArgs({ useAppServer: true });

            state.setTurnInFlight(false);
            handle({ type: 'task_complete' });

            expect(scheduleReadyAfterTurn).toHaveBeenCalled();
        });

        it('does not call sendReady directly for terminal events in appServer mode', () => {
            const { handle, sendReady } = buildArgs({ useAppServer: true });

            handle({ type: 'task_complete' });

            expect(sendReady).not.toHaveBeenCalled();
        });
    });

    describe('allowAnonymousTerminalEvent', () => {
        it('sets allowAnonymous on task_started without turnId in appServer mode', () => {
            const { handle, state } = buildArgs({ useAppServer: true });

            handle({ type: 'task_started' });

            expect(state.getAllowAnonymousTerminalEvent()).toBe(true);
        });

        it('clears allowAnonymous on task_started with turnId', () => {
            const { handle, state } = buildArgs({ useAppServer: true });
            state.setAllowAnonymousTerminalEvent(true);

            handle({ type: 'task_started', turn_id: 'turn-1' });

            expect(state.getAllowAnonymousTerminalEvent()).toBe(false);
        });
    });
});
