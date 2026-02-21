import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from './loop';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';

const queryMock = vi.fn();

vi.mock('@/claude/sdk', () => ({
    query: queryMock,
    AbortError: class AbortError extends Error {},
}));

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/parsers/specialCommands', () => ({
    parseSpecialCommand: () => ({ type: null })
}));

vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    }
}));

vi.mock('./utils/path', () => ({
    getProjectPath: () => '/tmp/project'
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: 'test-system-prompt'
}));

vi.mock('@/constants/uploadPaths', () => ({
    getHapiBlobsDir: () => '/tmp/blobs'
}));

type UserInput = { message: string, mode: EnhancedMode };

function makeResult() {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        session_id: 'session-1'
    };
}

function makeAssistant(text: string) {
    return {
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }]
        }
    };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

function createNextMessageController(initial: UserInput) {
    const queuedInputs: UserInput[] = [];
    const waitingResolvers: Array<(value: UserInput | null) => void> = [];
    const waitingAbortCleanups: Array<() => void> = [];
    let first = true;
    let closed = false;
    let abortCount = 0;

    const resolveNextWaiter = (value: UserInput | null) => {
        const resolver = waitingResolvers.shift();
        const cleanup = waitingAbortCleanups.shift();
        if (!resolver || !cleanup) {
            return false;
        }
        cleanup();
        resolver(value);
        return true;
    };

    const nextMessage = (abortSignal?: AbortSignal): Promise<UserInput | null> => {
        if (first) {
            first = false;
            return Promise.resolve(initial);
        }

        if (queuedInputs.length > 0) {
            return Promise.resolve(queuedInputs.shift()!);
        }

        if (closed) {
            return Promise.resolve(null);
        }

        if (abortSignal?.aborted) {
            abortCount += 1;
            return Promise.resolve(null);
        }

        return new Promise<UserInput | null>((resolve) => {
            if (!abortSignal) {
                waitingResolvers.push(resolve);
                waitingAbortCleanups.push(() => {});
                return;
            }

            const onAbort = () => {
                const index = waitingResolvers.indexOf(resolve);
                if (index !== -1) {
                    waitingResolvers.splice(index, 1);
                    const cleanup = waitingAbortCleanups.splice(index, 1)[0];
                    cleanup();
                }
                abortCount += 1;
                resolve(null);
            };

            const cleanup = () => abortSignal.removeEventListener('abort', onAbort);
            abortSignal.addEventListener('abort', onAbort, { once: true });
            waitingResolvers.push(resolve);
            waitingAbortCleanups.push(cleanup);
        });
    };

    return {
        nextMessage,
        enqueue(input: UserInput) {
            if (!resolveNextWaiter(input)) {
                queuedInputs.push(input);
            }
        },
        close() {
            closed = true;
            while (resolveNextWaiter(null)) {
                // Resolve all pending waits as closed.
            }
        },
        getAbortCount() {
            return abortCount;
        }
    };
}

describe('claudeRemote', () => {
    let sdkMessages: PushableAsyncIterable<any>;
    let promptMessages: any[];

    beforeEach(() => {
        sdkMessages = new PushableAsyncIterable<any>();
        promptMessages = [];
        queryMock.mockReset();
        queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
            void (async () => {
                for await (const message of prompt) {
                    promptMessages.push(message);
                }
            })();
            return {
                next: () => sdkMessages.next(),
                [Symbol.asyncIterator]: () => sdkMessages,
                get inputStreamQueueLength() {
                    return sdkMessages.queueSize;
                }
            };
        });
    });

    it('does not consume user input while Claude is still producing output after result', async () => {
        const { claudeRemote } = await import('./claudeRemote');
        const mode: EnhancedMode = { permissionMode: 'default' };
        const nextMessages = createNextMessageController({ message: 'initial', mode });
        const onReady = vi.fn();

        const run = claudeRemote({
            sessionId: null,
            path: '.',
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: nextMessages.nextMessage,
            onReady,
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
        });

        await waitForCondition(() => promptMessages.length === 1);
        expect(promptMessages[0]?.message?.content).toBe('initial');

        sdkMessages.push(makeResult());
        await waitForCondition(() => onReady.mock.calls.length >= 1);

        sdkMessages.push(makeAssistant('background-step'));
        sdkMessages.push(makeResult());
        await waitForCondition(() => nextMessages.getAbortCount() > 0);

        nextMessages.enqueue({ message: 'commit', mode });
        await waitForCondition(() => promptMessages.some((message) => message?.message?.content === 'commit'));

        sdkMessages.push(makeResult());
        nextMessages.close();

        await run;

        const pushedUserMessages = promptMessages
            .filter((message) => message?.type === 'user')
            .map((message) => message.message.content);

        expect(pushedUserMessages).toEqual(['initial', 'commit']);
        expect(nextMessages.getAbortCount()).toBeGreaterThan(0);
    });
});
