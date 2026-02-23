import { randomUUID } from 'node:crypto';

import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { CodexActiveCallTracker, handleCodexCollaborativeEvent } from './codexRemoteLauncherCollaborative';
import { asRecord, asString, formatOutputPreview, normalizeCommand } from './codexRemoteLauncherMessageUtils';
import type { CodexSession } from './session';
import type { DiffProcessor } from './utils/diffProcessor';
import type { ReasoningProcessor } from './utils/reasoningProcessor';

type CodexEventStateStore = {
    getCurrentThreadId: () => string | null;
    setCurrentThreadId: (threadId: string | null) => void;
    getCurrentTurnId: () => string | null;
    setCurrentTurnId: (turnId: string | null) => void;
    setTurnInFlight: (inFlight: boolean) => void;
};

type CodexRemoteEventHandlerArgs = {
    session: CodexSession;
    messageBuffer: MessageBuffer;
    useAppServer: boolean;
    callTracker: CodexActiveCallTracker;
    reasoningProcessor: ReasoningProcessor;
    diffProcessor: DiffProcessor;
    cleanupTimedOutCallsAtTurnEnd: () => void;
    sendReady: () => void;
    onTurnSettled: () => void;
    state: CodexEventStateStore;
};

function buildToolPayload(msg: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...msg };
    delete payload.type;
    delete payload.call_id;
    delete payload.callId;
    delete payload.thread_id;
    delete payload.threadId;
    return payload;
}

function isTurnSettled(msgType: string): boolean {
    return msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';
}

export function createCodexRemoteEventHandler(args: CodexRemoteEventHandlerArgs): (msg: Record<string, unknown>) => void {
    const {
        session,
        messageBuffer,
        useAppServer,
        callTracker,
        reasoningProcessor,
        diffProcessor,
        cleanupTimedOutCallsAtTurnEnd,
        sendReady,
        onTurnSettled,
        state
    } = args;

    return (msg: Record<string, unknown>) => {
        const msgType = asString(msg.type);
        if (!msgType) return;

        const eventTurnId = asString(msg.turn_id ?? msg.turnId) ?? state.getCurrentTurnId();

        if (msgType === 'thread_started') {
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (threadId) {
                const isMainThread = !state.getCurrentThreadId();
                if (isMainThread) {
                    state.setCurrentThreadId(threadId);
                    session.onSessionFound(threadId);
                }
                session.sendCodexMessage({
                    type: 'event',
                    subtype: 'thread_started',
                    thread_id: threadId,
                    is_main: isMainThread,
                    id: randomUUID()
                });
            }
            return;
        }

        if (msgType === 'task_started') {
            const turnId = asString(msg.turn_id ?? msg.turnId);
            if (turnId) {
                state.setCurrentTurnId(turnId);
            }
        }

        if (isTurnSettled(msgType)) {
            state.setCurrentTurnId(null);
        }

        if (!useAppServer) {
            logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

            if (msgType === 'event_msg' || msgType === 'response_item' || msgType === 'session_meta') {
                const payload = asRecord(msg.payload);
                const payloadType = asString(payload?.type);
                logger.debug(`[Codex] MCP wrapper event type: ${msgType}${payloadType ? ` (payload=${payloadType})` : ''}`);
            }
        }

        if (handleCodexCollaborativeEvent({
            msg,
            session,
            messageBuffer,
            callTracker
        })) {
            return;
        }

        if (msgType === 'agent_message') {
            const message = asString(msg.message);
            if (message) {
                messageBuffer.addMessage(message, 'assistant');
            }
        } else if (msgType === 'agent_reasoning') {
            const text = asString(msg.text);
            if (text) {
                messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
            }
        } else if (msgType === 'exec_command_begin') {
            const command = normalizeCommand(msg.command) ?? 'command';
            messageBuffer.addMessage(`Executing: ${command}`, 'tool');
        } else if (msgType === 'exec_command_end') {
            const output = msg.output ?? msg.error ?? 'Command completed';
            const outputText = formatOutputPreview(output);
            const truncatedOutput = outputText.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msgType === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msgType === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            cleanupTimedOutCallsAtTurnEnd();
            sendReady();
        } else if (msgType === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            cleanupTimedOutCallsAtTurnEnd();
            sendReady();
        } else if (msgType === 'task_failed') {
            const error = asString(msg.error);
            messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
            cleanupTimedOutCallsAtTurnEnd();
            sendReady();
        }

        if (msgType === 'task_started') {
            if (useAppServer) {
                state.setTurnInFlight(true);
            }
            if (!session.thinking) {
                logger.debug('thinking started');
                session.onThinkingChange(true);
            }
        }
        if (isTurnSettled(msgType)) {
            if (useAppServer) {
                state.setTurnInFlight(false);
            }
            if (session.thinking) {
                logger.debug('thinking completed');
                session.onThinkingChange(false);
            }
            onTurnSettled();
        }
        if (msgType === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msgType === 'agent_reasoning_delta') {
            const delta = asString(msg.delta);
            if (delta) {
                reasoningProcessor.processDelta(delta, asString(msg.thread_id ?? msg.threadId) ?? undefined);
            }
        }
        if (msgType === 'agent_reasoning') {
            const text = asString(msg.text);
            if (text) {
                reasoningProcessor.complete(text, asString(msg.thread_id ?? msg.threadId) ?? undefined);
            }
        }
        if (msgType === 'agent_message') {
            const message = asString(msg.message);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (message) {
                session.sendCodexMessage({
                    type: 'message',
                    message,
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(eventTurnId ? { turnId: eventTurnId } : {}),
                    id: randomUUID()
                });
            }
        }
        if (msgType === 'user_message_item') {
            const callId = asString(msg.call_id ?? msg.callId);
            const status = asString(msg.status);
            const message = asString(msg.message);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            session.sendCodexMessage({
                type: 'user_message_item',
                ...(callId ? { call_id: callId } : {}),
                ...(status ? { status } : {}),
                ...(message ? { message } : {}),
                ...(threadId ? { thread_id: threadId } : {}),
                ...(eventTurnId ? { turnId: eventTurnId } : {}),
                id: randomUUID()
            });
        }
        if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
            const callId = asString(msg.call_id ?? msg.callId);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (callId) {
                callTracker.start(callId, 'exec_command');
                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexBash',
                    callId: callId,
                    input: buildToolPayload(msg),
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(eventTurnId ? { turnId: eventTurnId } : {}),
                    id: randomUUID()
                });
            }
        }
        if (msgType === 'exec_command_end') {
            const callId = asString(msg.call_id ?? msg.callId);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (callId) {
                callTracker.end(callId, 'exec_command');
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: callId,
                    output: buildToolPayload(msg),
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(eventTurnId ? { turnId: eventTurnId } : {}),
                    id: randomUUID()
                });
            }
        }
        if (msgType === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msgType === 'patch_apply_begin') {
            const callId = asString(msg.call_id ?? msg.callId);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (callId) {
                callTracker.start(callId, 'patch_apply');
                const changes = asRecord(msg.changes) ?? {};
                const changeCount = Object.keys(changes).length;
                const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexPatch',
                    callId: callId,
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(eventTurnId ? { turnId: eventTurnId } : {}),
                    input: {
                        auto_approved: msg.auto_approved ?? msg.autoApproved,
                        changes
                    },
                    id: randomUUID()
                });
            }
        }
        if (msgType === 'patch_apply_end') {
            const callId = asString(msg.call_id ?? msg.callId);
            const threadId = asString(msg.thread_id ?? msg.threadId);
            if (callId) {
                callTracker.end(callId, 'patch_apply');
                const stdout = asString(msg.stdout);
                const stderr = asString(msg.stderr);
                const success = Boolean(msg.success);

                if (success) {
                    const message = stdout || 'Files modified successfully';
                    messageBuffer.addMessage(message.substring(0, 200), 'result');
                } else {
                    const errorMsg = stderr || 'Failed to modify files';
                    messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                }

                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: callId,
                    ...(threadId ? { thread_id: threadId } : {}),
                    ...(eventTurnId ? { turnId: eventTurnId } : {}),
                    output: {
                        stdout,
                        stderr,
                        success
                    },
                    id: randomUUID()
                });
            }
        }
        if (msgType === 'turn_diff') {
            const diff = asString(msg.unified_diff);
            if (diff) {
                diffProcessor.processDiff(diff);
            }
        }
    };
}
