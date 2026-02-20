import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexSession } from './session';
import { asString, asStringArray } from './codexRemoteLauncherMessageUtils';

export const CODEX_ACTIVE_CALL_TIMEOUT_MS = 5 * 60 * 1000;

type ActiveCodexCall = {
    type: string;
    startedAt: number;
};

type CodexSessionForwarding = Pick<CodexSession, 'sendCodexMessage' | 'sendSessionEvent'>;

function extractCallId(value: Record<string, unknown>): string | null {
    return asString(value.call_id ?? value.callId);
}

function toCodexPayload(value: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...value };
    delete payload.type;
    delete payload.call_id;
    delete payload.callId;
    return payload;
}

function toToolPayload(value: Record<string, unknown>): Record<string, unknown> {
    const payload = toCodexPayload(value);
    delete payload.status;
    return payload;
}

function toToolResultOutput(payload: Record<string, unknown>): unknown {
    return Object.keys(payload).length > 0 ? payload : 'completed';
}

function normalizeBeginEndStatus(value: unknown): 'begin' | 'end' {
    return value === 'end' ? 'end' : 'begin';
}

export class CodexActiveCallTracker {
    private readonly activeCallIds = new Map<string, ActiveCodexCall>();
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    start(callId: string, type: string): void {
        this.activeCallIds.set(callId, {
            type,
            startedAt: this.now()
        });
    }

    end(callId: string, type: string): void {
        const active = this.activeCallIds.get(callId);
        if (!active) {
            logger.warn('[Codex] tool-call end missing active call', {
                callId,
                type
            });
            return;
        }

        if (active.type !== type) {
            logger.warn('[Codex] tool-call end type mismatch', {
                callId,
                expectedType: active.type,
                receivedType: type
            });
        }

        this.activeCallIds.delete(callId);
    }

    cleanupTimedOut(onTimedOut: (callId: string, activeCall: ActiveCodexCall) => void): void {
        const now = this.now();
        for (const [callId, activeCall] of this.activeCallIds.entries()) {
            if (now - activeCall.startedAt < CODEX_ACTIVE_CALL_TIMEOUT_MS) {
                continue;
            }

            onTimedOut(callId, activeCall);
            this.activeCallIds.delete(callId);
        }
    }

    size(): number {
        return this.activeCallIds.size;
    }
}

export function emitTimedOutToolCallResultsAtTurnEnd(args: {
    callTracker: CodexActiveCallTracker;
    sendCodexMessage: (message: unknown) => void;
}): void {
    args.callTracker.cleanupTimedOut((callId, activeCall) => {
        logger.warn('[Codex] tool-call timed out at turn end', {
            callId,
            type: activeCall.type,
            startedAt: activeCall.startedAt
        });
        args.sendCodexMessage({
            type: 'tool-call-result',
            callId,
            output: 'timed out',
            is_error: true,
            id: randomUUID()
        });
    });
}

export function handleCodexCollaborativeEvent(args: {
    msg: Record<string, unknown>;
    session: CodexSessionForwarding;
    messageBuffer: Pick<MessageBuffer, 'addMessage'>;
    callTracker: CodexActiveCallTracker;
}): boolean {
    const { msg, session, messageBuffer, callTracker } = args;
    const msgType = asString(msg.type);
    if (!msgType) {
        return false;
    }

    if (msgType === 'collab_agent_spawn') {
        const callId = extractCallId(msg);
        if (!callId) {
            logger.warn('[Codex] collab_agent_spawn missing callId', { msg });
            return true;
        }

        const status = normalizeBeginEndStatus(msg.status);
        const payload = toToolPayload(msg);
        const receiverThreadIds = asStringArray(msg.receiver_thread_ids ?? msg.receiverThreadIds);
        if (status === 'begin') {
            callTracker.start(callId, 'collab_agent_spawn');
            messageBuffer.addMessage('Spawning sub-agent...', 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                callId,
                name: 'CodexSubAgent',
                input: payload,
                id: randomUUID()
            });
            return true;
        }

        callTracker.end(callId, 'collab_agent_spawn');
        messageBuffer.addMessage('Sub-agent completed', 'result');
        session.sendCodexMessage({
            type: 'tool-call-result',
            callId,
            output: toToolResultOutput({
                ...payload,
                ...(receiverThreadIds ? { receiver_thread_ids: receiverThreadIds } : {})
            }),
            id: randomUUID()
        });
        return true;
    }

    if (msgType === 'collab_tool_call_begin' || msgType === 'collab_tool_call_end') {
        const callId = extractCallId(msg);
        if (!callId) {
            logger.warn('[Codex] collab_tool_call event missing callId', { msgType, msg });
            return true;
        }

        const payload = toToolPayload(msg);
        if (msgType === 'collab_tool_call_begin') {
            callTracker.start(callId, 'collab_tool_call');
            messageBuffer.addMessage('Starting collaboration call...', 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                callId,
                name: 'CodexCollabCall',
                input: payload,
                id: randomUUID()
            });
            return true;
        }

        callTracker.end(callId, 'collab_tool_call');
        messageBuffer.addMessage('Collaboration call completed', 'result');
        session.sendCodexMessage({
            type: 'tool-call-result',
            callId,
            output: toToolResultOutput(payload),
            id: randomUUID()
        });
        return true;
    }

    if (msgType === 'web_search_begin' || msgType === 'web_search_end') {
        const callId = extractCallId(msg);
        if (!callId) {
            logger.warn('[Codex] web_search event missing callId', { msgType, msg });
            return true;
        }

        const payload = toToolPayload(msg);
        if (msgType === 'web_search_begin') {
            const query = asString(payload.query);
            callTracker.start(callId, 'web_search');
            messageBuffer.addMessage(query ? `Web search: ${query}` : 'Starting web search...', 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                callId,
                name: 'CodexWebSearch',
                input: payload,
                id: randomUUID()
            });
            return true;
        }

        callTracker.end(callId, 'web_search');
        messageBuffer.addMessage('Web search completed', 'result');
        session.sendCodexMessage({
            type: 'tool-call-result',
            callId,
            output: toToolResultOutput(payload),
            id: randomUUID()
        });
        return true;
    }

    if (msgType === 'collab_waiting') {
        const status = normalizeBeginEndStatus(msg.status);
        const payload = toToolPayload(msg);
        const callId = extractCallId(msg);
        messageBuffer.addMessage(
            status === 'begin' ? 'Waiting for sub-agent...' : 'Sub-agent wait completed',
            'status'
        );
        session.sendCodexMessage({
            type: 'event',
            subtype: 'collab_waiting',
            status,
            ...(callId ? { callId } : {}),
            ...payload,
            id: randomUUID()
        });
        return true;
    }

    return false;
}
