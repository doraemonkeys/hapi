import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CODEX_ACTIVE_CALL_TIMEOUT_MS,
    CodexActiveCallTracker,
    emitTimedOutToolCallResultsAtTurnEnd,
    handleCodexCollaborativeEvent
} from './codexRemoteLauncher';

describe('codexRemoteLauncher forwarding', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards collab agent spawn begin/end as tool-call messages with a shared callId', () => {
        const session = {
            sendCodexMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        };
        const messageBuffer = {
            addMessage: vi.fn()
        };
        const tracker = new CodexActiveCallTracker(() => 100);

        const beginHandled = handleCodexCollaborativeEvent({
            msg: {
                type: 'collab_agent_spawn',
                status: 'begin',
                call_id: 'spawn-1',
                prompt: 'Investigate tests',
                thread_id: 'thread-2'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        expect(beginHandled).toBe(true);
        expect(tracker.size()).toBe(1);
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call',
            name: 'CodexSubAgent',
            callId: 'spawn-1',
            input: expect.objectContaining({
                prompt: 'Investigate tests',
                thread_id: 'thread-2'
            })
        }));

        session.sendCodexMessage.mockClear();

        const endHandled = handleCodexCollaborativeEvent({
            msg: {
                type: 'collab_agent_spawn',
                status: 'end',
                call_id: 'spawn-1',
                thread_id: 'thread-2',
                receiver_thread_ids: ['thread-sub-1']
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        expect(endHandled).toBe(true);
        expect(tracker.size()).toBe(0);
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'spawn-1',
            output: expect.objectContaining({
                receiver_thread_ids: ['thread-sub-1']
            })
        }));
    });

    it('forwards collab tool calls and web search begin/end', () => {
        const session = {
            sendCodexMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        };
        const messageBuffer = {
            addMessage: vi.fn()
        };
        const tracker = new CodexActiveCallTracker(() => 100);

        handleCodexCollaborativeEvent({
            msg: {
                type: 'collab_tool_call_begin',
                call_id: 'call-1',
                prompt: 'Summarize docs'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        handleCodexCollaborativeEvent({
            msg: {
                type: 'collab_tool_call_end',
                call_id: 'call-1'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        handleCodexCollaborativeEvent({
            msg: {
                type: 'web_search_begin',
                call_id: 'ws-1',
                query: 'vitest mock docs',
                action: 'search'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        handleCodexCollaborativeEvent({
            msg: {
                type: 'web_search_end',
                call_id: 'ws-1'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        expect(tracker.size()).toBe(0);
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call',
            name: 'CodexCollabCall',
            callId: 'call-1'
        }));
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-1'
        }));
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call',
            name: 'CodexWebSearch',
            callId: 'ws-1',
            input: expect.objectContaining({
                query: 'vitest mock docs',
                action: 'search'
            })
        }));
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'ws-1'
        }));
    });

    it('forwards collab_waiting through sendCodexMessage and never sendSessionEvent', () => {
        const session = {
            sendCodexMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        };
        const messageBuffer = {
            addMessage: vi.fn()
        };
        const tracker = new CodexActiveCallTracker(() => 100);

        const handled = handleCodexCollaborativeEvent({
            msg: {
                type: 'collab_waiting',
                status: 'begin',
                call_id: 'wait-1',
                conversation_id: 'conv-1'
            },
            session,
            messageBuffer,
            callTracker: tracker
        });

        expect(handled).toBe(true);
        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'event',
            subtype: 'collab_waiting',
            status: 'begin',
            callId: 'wait-1',
            conversation_id: 'conv-1'
        }));
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('warns on call end mismatches and unknown call end events', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const tracker = new CodexActiveCallTracker(() => 100);

        tracker.start('call-2', 'web_search');
        tracker.end('call-2', 'collab_tool_call');
        tracker.end('missing-call', 'web_search');

        expect(warnSpy.mock.calls.some(([message]) =>
            typeof message === 'string' && message.includes('type mismatch')
        )).toBe(true);
        expect(warnSpy.mock.calls.some(([message]) =>
            typeof message === 'string' && message.includes('missing active call')
        )).toBe(true);
    });

    it('emits timed out tool-call-result entries at turn end', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        let now = 0;
        const tracker = new CodexActiveCallTracker(() => now);
        const sendCodexMessage = vi.fn();

        tracker.start('stale-call', 'collab_agent_spawn');
        now = CODEX_ACTIVE_CALL_TIMEOUT_MS + 1;

        emitTimedOutToolCallResultsAtTurnEnd({
            callTracker: tracker,
            sendCodexMessage
        });

        expect(tracker.size()).toBe(0);
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'stale-call',
            output: 'timed out',
            is_error: true
        }));
        expect(warnSpy.mock.calls.some(([message]) =>
            typeof message === 'string' && message.includes('timed out at turn end')
        )).toBe(true);
    });
});
