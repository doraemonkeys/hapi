import { logger } from '@/ui/logger';
import { AppServerEventConverterCallIdResolver } from './appServerEventConverterCallIdResolver';
import {
    asBoolean,
    asNumber,
    asRecord,
    asString,
    asStringArray,
    CODEX_EVENT_PREFIX,
    extractChanges,
    extractCodexMessage,
    extractCommand,
    extractItem,
    extractItemId,
    normalizeItemType,
    REDUNDANT_CODEX_EVENT_SUFFIXES
} from './appServerEventConverterParsing';
import type { ConvertedEvent } from './appServerEventConverterParsing';

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
    private readonly fileChangeMeta = new Map<string, Record<string, unknown>>();
    private readonly callIdResolver = new AppServerEventConverterCallIdResolver();

    private extractTurnId(...records: Array<Record<string, unknown> | null | undefined>): string | null {
        for (const record of records) {
            if (!record) continue;
            const turnId = asString(record.turnId ?? record.turn_id);
            if (turnId) {
                return turnId;
            }
        }
        return null;
    }

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};

        if (method.startsWith(CODEX_EVENT_PREFIX)) {
            const codexEventType = method.slice(CODEX_EVENT_PREFIX.length);
            if (REDUNDANT_CODEX_EVENT_SUFFIXES.has(codexEventType)) {
                return events;
            }

            const codexEvent = this.mapCodexEvent(method, paramsRecord);
            if (codexEvent) {
                events.push(codexEvent);
                return events;
            }
        }

        if (method === 'thread/started' || method === 'thread/resumed') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const threadId = asString(thread.threadId ?? thread.thread_id ?? thread.id);
            if (threadId) {
                events.push({ type: 'thread_started', thread_id: threadId });
            }
            return events;
        }

        if (method === 'turn/started') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? turn.threadId ?? turn.thread_id);
            events.push({ 
                type: 'task_started', 
                ...(turnId ? { turn_id: turnId } : {}),
                ...(threadId ? { thread_id: threadId } : {})
            });
            return events;
        }

        if (method === 'turn/completed') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const statusRaw = asString(paramsRecord.status ?? turn.status);
            const status = statusRaw?.toLowerCase();
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            const errorMessage = asString(paramsRecord.error ?? paramsRecord.message ?? paramsRecord.reason);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? turn.threadId ?? turn.thread_id);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push({ 
                    type: 'turn_aborted', 
                    ...(turnId ? { turn_id: turnId } : {}),
                    ...(threadId ? { thread_id: threadId } : {})
                });
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push({ 
                    type: 'task_failed', 
                    ...(turnId ? { turn_id: turnId } : {}), 
                    ...(errorMessage ? { error: errorMessage } : {}),
                    ...(threadId ? { thread_id: threadId } : {})
                });
                return events;
            }

            events.push({ 
                type: 'task_complete', 
                ...(turnId ? { turn_id: turnId } : {}),
                ...(threadId ? { thread_id: threadId } : {})
            });
            return events;
        }

        if (method === 'turn/diff/updated') {
            const diff = asString(paramsRecord.diff ?? paramsRecord.unified_diff ?? paramsRecord.unifiedDiff);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id);
            const turnId = this.extractTurnId(paramsRecord);
            if (diff) {
                events.push({ 
                    type: 'turn_diff', 
                    unified_diff: diff,
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                });
            }
            return events;
        }

        if (method === 'thread/tokenUsage/updated') {
            const info = asRecord(paramsRecord.tokenUsage ?? paramsRecord.token_usage ?? paramsRecord) ?? {};
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id);
            events.push({ 
                type: 'token_count', 
                info,
                ...(threadId ? { thread_id: threadId } : {})
            });
            return events;
        }

        if (method === 'error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message) ?? asString(asRecord(paramsRecord.error)?.message);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id);
            if (message) {
                events.push({ 
                    type: 'task_failed', 
                    error: message,
                    ...(threadId ? { thread_id: threadId } : {})
                });
            }
            return events;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (itemId && delta) {
                const prev = this.agentMessageBuffers.get(itemId) ?? '';
                this.agentMessageBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/reasoning/textDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            const item = asRecord(paramsRecord.item);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? item?.threadId ?? item?.thread_id);
            const turnId = this.extractTurnId(paramsRecord, item);
            if (delta) {
                const prev = this.reasoningBuffers.get(itemId) ?? '';
                this.reasoningBuffers.set(itemId, prev + delta);
                events.push({
                    type: 'agent_reasoning_delta',
                    delta,
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                });
            }
            return events;
        }

        if (method === 'item/reasoning/summaryTextDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            const item = asRecord(paramsRecord.item);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? item?.threadId ?? item?.thread_id);
            const turnId = this.extractTurnId(paramsRecord, item);
            if (!delta) {
                return events;
            }

            const prev = this.reasoningBuffers.get(itemId) ?? '';
            this.reasoningBuffers.set(itemId, prev + delta);
            events.push({
                type: 'agent_reasoning_delta',
                delta,
                ...(threadId ? { thread_id: threadId } : {}),
                ...(turnId ? { turn_id: turnId } : {})
            });
            return events;
        }

        if (method === 'item/reasoning/summaryPartAdded') {
            const item = asRecord(paramsRecord.item);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? item?.threadId ?? item?.thread_id);
            const turnId = this.extractTurnId(paramsRecord, item);
            events.push({
                type: 'agent_reasoning_section_break',
                ...(threadId ? { thread_id: threadId } : {}),
                ...(turnId ? { turn_id: turnId } : {})
            });
            return events;
        }

        if (method === 'item/commandExecution/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const prev = this.commandOutputBuffers.get(itemId) ?? '';
                this.commandOutputBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/started' || method === 'item/completed') {
            const item = extractItem(paramsRecord);
            if (!item) return events;

            const itemType = normalizeItemType(item.type ?? item.itemType ?? item.kind);
            const itemId = extractItemId(paramsRecord) ?? asString(item.id ?? item.itemId ?? item.item_id);
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? item.threadId ?? item.thread_id);
            const turnId = this.extractTurnId(paramsRecord, item);

            if (!itemType || !itemId) {
                return events;
            }

            if (itemType === 'agentmessage') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.agentMessageBuffers.get(itemId);
                    if (text) {
                        events.push({
                            type: 'agent_message',
                            message: text,
                            ...(threadId ? { thread_id: threadId } : {}),
                            ...(turnId ? { turn_id: turnId } : {})
                        });
                    }
                    this.agentMessageBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'reasoning') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.reasoningBuffers.get(itemId);
                    if (text) {
                        events.push({
                            type: 'agent_reasoning',
                            text,
                            ...(threadId ? { thread_id: threadId } : {}),
                            ...(turnId ? { turn_id: turnId } : {})
                        });
                    }
                    this.reasoningBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'commandexecution') {
                if (method === 'item/started') {
                    const command = extractCommand(item.command ?? item.cmd ?? item.args);
                    const cwd = asString(item.cwd ?? item.workingDirectory ?? item.working_directory);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (command) meta.command = command;
                    if (cwd) meta.cwd = cwd;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.commandMeta.set(itemId, meta);

                    events.push({
                        type: 'exec_command_begin',
                        call_id: itemId,
                        ...meta,
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.commandMeta.get(itemId) ?? {};
                    const output = asString(item.output ?? item.result ?? item.stdout) ?? this.commandOutputBuffers.get(itemId);
                    const stderr = asString(item.stderr);
                    const error = asString(item.error);
                    const exitCode = asNumber(item.exitCode ?? item.exit_code ?? item.exitcode);
                    const status = asString(item.status);

                    events.push({
                        type: 'exec_command_end',
                        call_id: itemId,
                        ...meta,
                        ...(output ? { output } : {}),
                        ...(stderr ? { stderr } : {}),
                        ...(error ? { error } : {}),
                        ...(exitCode !== null ? { exit_code: exitCode } : {}),
                        ...(status ? { status } : {}),
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });

                    this.commandMeta.delete(itemId);
                    this.commandOutputBuffers.delete(itemId);
                }

                return events;
            }

            if (itemType === 'filechange') {
                if (method === 'item/started') {
                    const changes = extractChanges(item.changes ?? item.change ?? item.diff);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (changes) meta.changes = changes;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.fileChangeMeta.set(itemId, meta);

                    events.push({
                        type: 'patch_apply_begin',
                        call_id: itemId,
                        ...meta,
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.fileChangeMeta.get(itemId) ?? {};
                    const stdout = asString(item.stdout ?? item.output);
                    const stderr = asString(item.stderr);
                    const success = asBoolean(item.success ?? item.ok ?? item.applied ?? item.status === 'completed');

                    events.push({
                        type: 'patch_apply_end',
                        call_id: itemId,
                        ...meta,
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        success: success ?? false,
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });

                    this.fileChangeMeta.delete(itemId);
                }

                return events;
            }

            if (itemType === 'collabagenttoolcall') {
                const prompt = asString(item.prompt ?? item.message ?? item.content);
                const senderThreadId = asString(item.senderThreadId ?? item.sender_thread_id);
                const receiverThreadIds = asStringArray(item.receiverThreadIds ?? item.receiver_thread_ids);
                const tool = asString(item.tool);
                if (method === 'item/started') {
                    events.push({
                        type: 'collab_tool_call_begin',
                        call_id: itemId,
                        ...(prompt ? { prompt } : {}),
                        ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
                        ...(receiverThreadIds ? { receiver_thread_ids: receiverThreadIds } : {}),
                        ...(tool ? { tool } : {}),
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }

                if (method === 'item/completed') {
                    events.push({
                        type: 'collab_tool_call_end',
                        call_id: itemId,
                        ...(prompt ? { prompt } : {}),
                        ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
                        ...(receiverThreadIds ? { receiver_thread_ids: receiverThreadIds } : {}),
                        ...(tool ? { tool } : {}),
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }
                return events;
            }

            if (itemType === 'websearch') {
                if (method === 'item/started') {
                    const query = asString(item.query ?? item.prompt ?? item.text);
                    const action = asString(item.action);
                    events.push({
                        type: 'web_search_begin',
                        call_id: itemId,
                        ...(query ? { query } : {}),
                        ...(action ? { action } : {}),
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }

                if (method === 'item/completed') {
                    events.push({
                        type: 'web_search_end',
                        call_id: itemId,
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }
                return events;
            }

            if (itemType === 'usermessage') {
                const text = asString(item.text ?? item.message ?? item.content);
                events.push({
                    type: 'user_message_item',
                    call_id: itemId,
                    status: method === 'item/started' ? 'begin' : 'end',
                    ...(text ? { message: text } : {}),
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                });
                return events;
            }

        }

        logger.debug('[AppServerEventConverter] Unhandled notification', { method, params });
        return events;
    }

    reset(): void {
        this.agentMessageBuffers.clear();
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.commandMeta.clear();
        this.fileChangeMeta.clear();
        this.callIdResolver.reset();
    }

    private mapCodexEvent(method: string, params: Record<string, unknown>): ConvertedEvent | null {
        if (!method.startsWith(CODEX_EVENT_PREFIX)) {
            return null;
        }

        const eventType = method.slice(CODEX_EVENT_PREFIX.length);
        const payload = extractCodexMessage(params);
        const conversationId = asString(params.conversationId ?? params.conversation_id);
        const turnId = this.extractTurnId(payload);

        if (
            eventType === 'collab_agent_spawn_begin' ||
            eventType === 'collab_agent_spawn_end' ||
            eventType === 'collab_waiting_begin' ||
            eventType === 'collab_waiting_end' ||
            eventType === 'collab_close_begin' ||
            eventType === 'collab_close_end'
        ) {
            const isBegin = eventType.endsWith('_begin');
            const status = isBegin ? 'begin' : 'end';

            if (eventType.startsWith('collab_agent_spawn_')) {
                const callId = this.callIdResolver.resolve({
                    scope: 'collab_agent_spawn',
                    status,
                    payload,
                    generatedPrefix: 'codex-collab'
                });
                const prompt = asString(payload.prompt ?? payload.message);
                const threadId = asString(payload.threadId ?? payload.thread_id);
                const senderThreadId = asString(payload.senderThreadId ?? payload.sender_thread_id);
                const receiverThreadIds = asStringArray(payload.receiverThreadIds ?? payload.receiver_thread_ids);
                const agentId = asString(payload.agentId ?? payload.agent_id);
                return {
                    type: 'collab_agent_spawn',
                    status,
                    call_id: callId,
                    ...(prompt ? { prompt } : {}),
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
                    ...(receiverThreadIds ? { receiver_thread_ids: receiverThreadIds } : {}),
                    ...(agentId ? { agent_id: agentId } : {}),
                    ...(conversationId ? { conversation_id: conversationId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                };
            }

            if (eventType.startsWith('collab_waiting_')) {
                const callId = this.callIdResolver.resolve({
                    scope: 'collab_waiting',
                    fallbackScopes: ['collab_agent_spawn'],
                    status,
                    payload,
                    generatedPrefix: 'codex-collab-wait'
                });
                return {
                    type: 'collab_waiting',
                    status,
                    call_id: callId,
                    ...(conversationId ? { conversation_id: conversationId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                };
            }

            if (eventType.startsWith('collab_close_')) {
                const callId = this.callIdResolver.resolve({
                    scope: 'collab_close',
                    fallbackScopes: ['collab_agent_spawn'],
                    status,
                    payload,
                    generatedPrefix: 'codex-collab-close'
                });
                return {
                    type: 'collab_close',
                    status,
                    call_id: callId,
                    ...(conversationId ? { conversation_id: conversationId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                };
            }
        }

        if (eventType === 'web_search_begin' || eventType === 'web_search_end') {
            const status = eventType.endsWith('_begin') ? 'begin' : 'end';
            const callId = this.callIdResolver.resolve({
                scope: 'web_search',
                status,
                payload,
                generatedPrefix: 'codex-ws'
            });
            if (eventType === 'web_search_begin') {
                const query = asString(payload.query ?? payload.prompt ?? payload.text);
                const action = asString(payload.action);
                return {
                    type: 'web_search_begin',
                    call_id: callId,
                    ...(query ? { query } : {}),
                    ...(action ? { action } : {}),
                    ...(conversationId ? { conversation_id: conversationId } : {}),
                    ...(turnId ? { turn_id: turnId } : {})
                };
            }

            return {
                type: 'web_search_end',
                call_id: callId,
                ...(conversationId ? { conversation_id: conversationId } : {}),
                ...(turnId ? { turn_id: turnId } : {})
            };
        }

        return null;
    }

}
