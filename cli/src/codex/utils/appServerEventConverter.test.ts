import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';

describe('AppServerEventConverter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('maps thread/started', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/started', { thread: { id: 'thread-1' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-1' }]);
    });

    it('maps thread/resumed', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/resumed', { thread: { id: 'thread-2' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-2' }]);
    });

    it('maps turn/started and completed statuses', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('turn/started', { turn: { id: 'turn-1' } });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Completed' });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);

        const interrupted = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Interrupted' });
        expect(interrupted).toEqual([{ type: 'turn_aborted', turn_id: 'turn-1' }]);

        const failed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Failed', message: 'boom' });
        expect(failed).toEqual([{ type: 'task_failed', turn_id: 'turn-1', error: 'boom' }]);
    });

    it('accumulates agent message deltas', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: ' world' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('maps command execution items and output deltas', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            call_id: 'cmd-1',
            command: 'ls'
        }]);

        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }
        });

        expect(completed).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            command: 'ls',
            output: 'ok',
            exit_code: 0
        }]);
    });

    it('maps reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('skips redundant codex/event notifications', () => {
        const converter = new AppServerEventConverter();

        const skipped = converter.handleNotification('codex/event/agent_message_delta', { msg: { id: 'm-1' } });
        converter.handleNotification('codex/event/agent_message_delta', { msg: { id: 'm-2' } });
        converter.handleNotification('codex/event/token_count', { msg: { id: 'tok-1' } });
        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-2' }, status: 'completed' });

        expect(skipped).toEqual([]);
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-2' }]);
    });

    it('maps codex collab and web search events', () => {
        const converter = new AppServerEventConverter();

        const spawnBegin = converter.handleNotification('codex/event/collab_agent_spawn_begin', {
            conversationId: 'conv-1',
            msg: {
                id: 'call-1',
                threadId: 'thread-child-1',
                prompt: 'Investigate issue',
                senderThreadId: 'thread-main-1',
                receiverThreadIds: ['thread-child-1']
            }
        });
        expect(spawnBegin).toEqual([{
            type: 'collab_agent_spawn',
            status: 'begin',
            call_id: 'call-1',
            prompt: 'Investigate issue',
            thread_id: 'thread-child-1',
            sender_thread_id: 'thread-main-1',
            receiver_thread_ids: ['thread-child-1'],
            conversation_id: 'conv-1'
        }]);

        const waitingBegin = converter.handleNotification('codex/event/collab_waiting_begin', {
            msg: {
                threadId: 'thread-child-1'
            }
        });
        expect(waitingBegin).toEqual([{
            type: 'collab_waiting',
            status: 'begin',
            call_id: 'call-1'
        }]);

        const spawnEnd = converter.handleNotification('codex/event/collab_agent_spawn_end', {
            msg: {
                threadId: 'thread-child-1'
            }
        });
        expect(spawnEnd).toEqual([{
            type: 'collab_agent_spawn',
            status: 'end',
            call_id: 'call-1',
            thread_id: 'thread-child-1'
        }]);

        const webSearchBegin = converter.handleNotification('codex/event/web_search_begin', {
            msg: {
                id: 'ws-1',
                query: 'vitest docs',
                action: 'search'
            }
        });
        expect(webSearchBegin).toEqual([{
            type: 'web_search_begin',
            call_id: 'ws-1',
            query: 'vitest docs',
            action: 'search'
        }]);

        const webSearchEnd = converter.handleNotification('codex/event/web_search_end', {
            msg: {
                id: 'ws-1'
            }
        });
        expect(webSearchEnd).toEqual([{
            type: 'web_search_end',
            call_id: 'ws-1'
        }]);
    });

    it('keeps spawn call-id correlation through waiting end before spawn end', () => {
        const converter = new AppServerEventConverter();

        const spawnBegin = converter.handleNotification('codex/event/collab_agent_spawn_begin', {
            msg: {
                id: 'spawn-regression-1',
                threadId: 'thread-regression-1'
            }
        });
        const waitingBegin = converter.handleNotification('codex/event/collab_waiting_begin', {
            msg: {
                threadId: 'thread-regression-1'
            }
        });
        const waitingEnd = converter.handleNotification('codex/event/collab_waiting_end', {
            msg: {
                threadId: 'thread-regression-1'
            }
        });
        const spawnEnd = converter.handleNotification('codex/event/collab_agent_spawn_end', {
            msg: {
                threadId: 'thread-regression-1'
            }
        });

        expect(spawnBegin).toEqual([{
            type: 'collab_agent_spawn',
            status: 'begin',
            call_id: 'spawn-regression-1',
            thread_id: 'thread-regression-1'
        }]);
        expect(waitingBegin).toEqual([{
            type: 'collab_waiting',
            status: 'begin',
            call_id: 'spawn-regression-1'
        }]);
        expect(waitingEnd).toEqual([{
            type: 'collab_waiting',
            status: 'end',
            call_id: 'spawn-regression-1'
        }]);
        expect(spawnEnd).toEqual([{
            type: 'collab_agent_spawn',
            status: 'end',
            call_id: 'spawn-regression-1',
            thread_id: 'thread-regression-1'
        }]);
    });

    it('falls back to thread ids for collab and web search call ids when id is missing', () => {
        const converter = new AppServerEventConverter();

        const spawnBegin = converter.handleNotification('codex/event/collab_agent_spawn_begin', {
            msg: {
                thread_id: 'thread-child-fallback',
                prompt: 'Investigate issue'
            }
        });
        expect(spawnBegin).toEqual([{
            type: 'collab_agent_spawn',
            status: 'begin',
            call_id: 'thread-child-fallback',
            prompt: 'Investigate issue',
            thread_id: 'thread-child-fallback'
        }]);

        const spawnEnd = converter.handleNotification('codex/event/collab_agent_spawn_end', {
            msg: {
                threadId: 'thread-child-fallback'
            }
        });
        expect(spawnEnd).toEqual([{
            type: 'collab_agent_spawn',
            status: 'end',
            call_id: 'thread-child-fallback',
            thread_id: 'thread-child-fallback'
        }]);

        const webSearchBegin = converter.handleNotification('codex/event/web_search_begin', {
            msg: {
                threadId: 'web-thread-fallback',
                query: 'vitest docs'
            }
        });
        expect(webSearchBegin).toEqual([{
            type: 'web_search_begin',
            call_id: 'web-thread-fallback',
            query: 'vitest docs'
        }]);

        const webSearchEnd = converter.handleNotification('codex/event/web_search_end', {
            msg: {
                thread_id: 'web-thread-fallback'
            }
        });
        expect(webSearchEnd).toEqual([{
            type: 'web_search_end',
            call_id: 'web-thread-fallback'
        }]);
    });

    it('correlates codex begin/end from msg ids and thread ids even when top-level ids differ', () => {
        const converter = new AppServerEventConverter();

        const spawnBegin = converter.handleNotification('codex/event/collab_agent_spawn_begin', {
            id: 'outer-event-1',
            msg: {
                id: 'spawn-call-1',
                threadId: 'thread-corr-1',
                prompt: 'Investigate issue'
            }
        });
        expect(spawnBegin).toEqual([{
            type: 'collab_agent_spawn',
            status: 'begin',
            call_id: 'spawn-call-1',
            prompt: 'Investigate issue',
            thread_id: 'thread-corr-1'
        }]);

        const spawnEnd = converter.handleNotification('codex/event/collab_agent_spawn_end', {
            id: 'outer-event-2',
            msg: {
                thread_id: 'thread-corr-1'
            }
        });
        expect(spawnEnd).toEqual([{
            type: 'collab_agent_spawn',
            status: 'end',
            call_id: 'spawn-call-1',
            thread_id: 'thread-corr-1'
        }]);

        const webSearchBegin = converter.handleNotification('codex/event/web_search_begin', {
            id: 'outer-event-3',
            msg: {
                threadId: 'web-corr-1',
                query: 'vitest docs'
            }
        });
        expect(webSearchBegin).toEqual([{
            type: 'web_search_begin',
            call_id: 'web-corr-1',
            query: 'vitest docs'
        }]);

        const webSearchEnd = converter.handleNotification('codex/event/web_search_end', {
            id: 'outer-event-4',
            msg: {
                thread_id: 'web-corr-1'
            }
        });
        expect(webSearchEnd).toEqual([{
            type: 'web_search_end',
            call_id: 'web-corr-1'
        }]);
    });

    it('maps collabagenttoolcall, websearch, and usermessage item types', () => {
        const converter = new AppServerEventConverter();

        const collabStarted = converter.handleNotification('item/started', {
            item: {
                id: 'call-22',
                type: 'collabagenttoolcall',
                prompt: 'Delegate',
                senderThreadId: 'thread-main',
                receiverThreadIds: ['thread-sub']
            }
        });
        expect(collabStarted).toEqual([{
            type: 'collab_tool_call_begin',
            call_id: 'call-22',
            prompt: 'Delegate',
            sender_thread_id: 'thread-main',
            receiver_thread_ids: ['thread-sub']
        }]);

        const collabCompleted = converter.handleNotification('item/completed', {
            item: { id: 'call-22', type: 'collabagenttoolcall' }
        });
        expect(collabCompleted).toEqual([{
            type: 'collab_tool_call_end',
            call_id: 'call-22'
        }]);

        const webSearchStarted = converter.handleNotification('item/started', {
            item: { id: 'ws-22', type: 'websearch', query: 'bun test', action: 'search' }
        });
        expect(webSearchStarted).toEqual([{
            type: 'web_search_begin',
            call_id: 'ws-22',
            query: 'bun test',
            action: 'search'
        }]);

        const webSearchCompleted = converter.handleNotification('item/completed', {
            item: { id: 'ws-22', type: 'websearch' }
        });
        expect(webSearchCompleted).toEqual([{
            type: 'web_search_end',
            call_id: 'ws-22'
        }]);

        const userMessageStarted = converter.handleNotification('item/started', {
            item: { id: 'usr-1', type: 'usermessage', text: 'hello' }
        });
        expect(userMessageStarted).toEqual([{
            type: 'user_message_item',
            call_id: 'usr-1',
            status: 'begin',
            message: 'hello'
        }]);
    });

    it('maps item/reasoning/summaryTextDelta into reasoning buffer', () => {
        const converter = new AppServerEventConverter();

        const delta1 = converter.handleNotification('item/reasoning/summaryTextDelta', { itemId: 'r-2', delta: 'first' });
        const delta2 = converter.handleNotification('item/reasoning/summaryTextDelta', { itemId: 'r-2', text: ' second' });
        const completed = converter.handleNotification('item/completed', { item: { id: 'r-2', type: 'reasoning' } });

        expect(delta1).toEqual([{ type: 'agent_reasoning_delta', delta: 'first' }]);
        expect(delta2).toEqual([{ type: 'agent_reasoning_delta', delta: ' second' }]);
        expect(completed).toEqual([{ type: 'agent_reasoning', text: 'first second' }]);
    });

    it('ignores summaryTextDelta when no usable delta value exists', () => {
        const converter = new AppServerEventConverter();

        const first = converter.handleNotification('item/reasoning/summaryTextDelta', { itemId: 'r-3', summaryIndex: 1 });
        const second = converter.handleNotification('item/reasoning/summaryTextDelta', { itemId: 'r-3', summaryIndex: 2 });

        expect(first).toEqual([]);
        expect(second).toEqual([]);
    });
});
