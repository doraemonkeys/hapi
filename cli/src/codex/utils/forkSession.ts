import { CodexAppServerClient } from '../codexAppServerClient';
import type { ThreadReadResponse } from '../appServerTypes';

const HAPI_CLIENT_INFO = {
    name: 'hapi',
    version: '1.0.0'
} as const;

export interface ForkCodexSessionOptions {
    sourceThreadId: string;
    forkAtTurnId: string;
}

type CodexThreadTurn = {
    id: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractThreadId(value: unknown): string | null {
    const response = asRecord(value);
    const thread = asRecord(response?.thread);
    return asString(thread?.id ?? response?.threadId ?? response?.thread_id);
}

function extractTurns(response: ThreadReadResponse): CodexThreadTurn[] {
    const responseRecord = asRecord(response);
    if (!responseRecord) {
        return [];
    }

    const threadRecord = asRecord(responseRecord.thread);
    const historyFromThread = asRecord(threadRecord?.history);
    const historyFromRoot = asRecord(responseRecord.history);
    const rawTurns = [
        threadRecord?.turns,
        responseRecord.turns,
        historyFromThread?.turns,
        historyFromRoot?.turns
    ].find((candidate) => Array.isArray(candidate));

    if (!Array.isArray(rawTurns)) {
        return [];
    }

    return rawTurns
        .map((turn) => {
            const turnRecord = asRecord(turn);
            if (!turnRecord) {
                return null;
            }
            const id = asString(turnRecord.id ?? turnRecord.turnId ?? turnRecord.turn_id);
            if (!id) {
                return null;
            }
            return { id };
        })
        .filter((turn): turn is CodexThreadTurn => turn !== null);
}

export async function forkCodexSession(opts: ForkCodexSessionOptions): Promise<{ newSessionId: string }> {
    const client = new CodexAppServerClient();
    try {
        await client.connect();
        await client.initialize({
            clientInfo: HAPI_CLIENT_INFO
        });

        // thread/fork doesn't accept a turnId parameter, so we fork the full thread
        // then read it back to locate the target turn and rollback excess turns.
        const forkResponse = await client.forkThread({
            threadId: opts.sourceThreadId
        });
        const newThreadId = extractThreadId(forkResponse);
        if (!newThreadId) {
            throw new Error('thread/fork did not return a new thread id');
        }

        const readResponse = await client.readThread({
            threadId: newThreadId,
            includeTurns: true
        });
        const turns = extractTurns(readResponse);
        const targetIndex = turns.findIndex((turn) => turn.id === opts.forkAtTurnId);
        if (targetIndex < 0) {
            throw new Error(`Fork target turn not found: ${opts.forkAtTurnId}`);
        }

        const turnsToRollback = turns.length - targetIndex - 1;
        if (turnsToRollback > 0) {
            await client.rollbackThread({
                threadId: newThreadId,
                numTurns: turnsToRollback
            });
        }

        return { newSessionId: newThreadId };
    } finally {
        await client.disconnect();
    }
}
