import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppServerEventConverter } from '../src/codex/utils/appServerEventConverter';
import { CodexActiveCallTracker, handleCodexCollaborativeEvent } from '../src/codex/codexRemoteLauncher';

type DebugEntry = {
    stage?: unknown;
    data?: unknown;
};

type JsonRecord = Record<string, unknown>;

const REAL_LOG_NOISE_METHODS = [
    'codex/event/agent_message_delta',
    'codex/event/agent_message_content_delta',
    'codex/event/reasoning_content_delta',
    'codex/event/exec_command_output_delta'
];

function asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function resolveDebugLogPath(): string {
    const candidates = [
        resolve(process.cwd(), '.claude', 'debug.log'),
        resolve(process.cwd(), '..', '.claude', 'debug.log')
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error('Unable to locate .claude/debug.log');
}

function incrementCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function replayCollaborativeEvents(converter: AppServerEventConverter, collabItemId: string, webSearchItemId: string): JsonRecord[] {
    const forwarded: JsonRecord[] = [];
    const session = {
        sendCodexMessage(message: JsonRecord) {
            forwarded.push(message);
        },
        sendSessionEvent() {
            throw new Error('collab/web_search events must not use sendSessionEvent');
        }
    };
    const messageBuffer = {
        addMessage() {
            // No-op: integration validation only needs forwarding shape.
        }
    };
    const tracker = new CodexActiveCallTracker(() => Date.now());
    const replay = (events: JsonRecord[]) => {
        for (const event of events) {
            const handled = handleCodexCollaborativeEvent({
                msg: event,
                session,
                messageBuffer,
                callTracker: tracker
            });
            assert(handled, `Expected collaborative event to be handled: ${JSON.stringify(event)}`);
        }
    };

    replay(converter.handleNotification('codex/event/collab_agent_spawn_begin', {
        msg: { id: 'real-log-spawn', prompt: 'Investigate', threadId: 'thread-sub' }
    }) as JsonRecord[]);
    replay(converter.handleNotification('codex/event/collab_agent_spawn_end', {
        msg: { id: 'real-log-spawn', threadId: 'thread-sub' }
    }) as JsonRecord[]);

    replay(converter.handleNotification('item/started', {
        item: {
            id: collabItemId,
            type: 'collabagenttoolcall',
            prompt: 'Delegate',
            senderThreadId: 'thread-main',
            receiverThreadIds: ['thread-sub']
        }
    }) as JsonRecord[]);
    replay(converter.handleNotification('item/completed', {
        item: { id: collabItemId, type: 'collabagenttoolcall' }
    }) as JsonRecord[]);

    replay(converter.handleNotification('codex/event/web_search_begin', {
        msg: { id: webSearchItemId, query: 'vitest docs', action: 'search' }
    }) as JsonRecord[]);
    replay(converter.handleNotification('codex/event/web_search_end', {
        msg: { id: webSearchItemId }
    }) as JsonRecord[]);

    assert(tracker.size() === 0, `Expected no active calls after replay, got ${tracker.size()}`);
    return forwarded;
}

function main(): void {
    const debugLogPath = resolveDebugLogPath();
    const lines = readFileSync(debugLogPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const unhandledMethodCounts = new Map<string, number>();
    const seenMethods = new Set<string>();
    const itemTypeSampleIds = new Map<string, string>();

    for (const line of lines) {
        let parsed: DebugEntry;
        try {
            parsed = JSON.parse(line) as DebugEntry;
        } catch {
            continue;
        }

        const stage = asString(parsed.stage);
        const data = asRecord(parsed.data);
        if (!stage || !data) continue;

        if (stage === 'app-server-notification-method-seen') {
            const method = asString(data.method);
            if (method) {
                seenMethods.add(method);
            }
            continue;
        }

        if (stage === 'app-server-notification-unhandled') {
            const method = asString(data.method);
            if (method) {
                incrementCount(unhandledMethodCounts, method);
            }
            continue;
        }

        if (stage === 'app-server-item-type-unhandled') {
            const itemType = asString(data.itemType);
            const itemId = asString(data.itemId);
            if (itemType && itemId && !itemTypeSampleIds.has(itemType)) {
                itemTypeSampleIds.set(itemType, itemId);
            }
        }
    }

    const noisyEvidence = REAL_LOG_NOISE_METHODS
        .map((method) => ({ method, count: unhandledMethodCounts.get(method) ?? 0 }))
        .filter((entry) => entry.count > 0);
    assert(noisyEvidence.length >= 3, `Expected >=3 noisy codex/event methods in real log, got ${noisyEvidence.length}`);

    const noiseReplayConverter = new AppServerEventConverter();
    for (const { method } of noisyEvidence) {
        const result = noiseReplayConverter.handleNotification(method, { msg: { id: `noise-${method}` } });
        assert(result.length === 0, `Expected noisy method to be skipped: ${method}`);
    }

    assert(seenMethods.has('codex/event/agent_message_delta'), 'Missing codex/event/agent_message_delta in real log');
    assert(seenMethods.has('item/agentMessage/delta'), 'Missing item/agentMessage/delta in real log');
    const duplicateGuardConverter = new AppServerEventConverter();
    const codexPath = duplicateGuardConverter.handleNotification('codex/event/agent_message_delta', { msg: { id: 'msg-dup' } });
    duplicateGuardConverter.handleNotification('item/agentMessage/delta', { itemId: 'msg-dup', delta: 'hello' });
    const completed = duplicateGuardConverter.handleNotification('item/completed', { item: { id: 'msg-dup', type: 'agentMessage' } });
    assert(codexPath.length === 0, 'codex/event/agent_message_delta must be skipped to avoid duplicate text');
    assert(
        completed.length === 1 &&
        asString(completed[0]?.type) === 'agent_message' &&
        asString(completed[0]?.message) === 'hello',
        'Expected exactly one agent_message from item/* path in duplicate-text replay'
    );

    assert(seenMethods.has('codex/event/collab_agent_spawn_begin'), 'Missing collab spawn method in real log');
    assert(seenMethods.has('codex/event/web_search_begin'), 'Missing web search method in real log');
    const collabItemId = itemTypeSampleIds.get('collabagenttoolcall');
    const webSearchItemId = itemTypeSampleIds.get('websearch');
    assert(collabItemId, 'Missing collabagenttoolcall sample in real log');
    assert(webSearchItemId, 'Missing websearch sample in real log');

    const collaborativeConverter = new AppServerEventConverter();
    const forwarded = replayCollaborativeEvents(collaborativeConverter, collabItemId, webSearchItemId);

    const hasSubAgentTool = forwarded.some((message) => asString(message.type) === 'tool-call' && asString(message.name) === 'CodexSubAgent');
    const hasCollabTool = forwarded.some((message) => asString(message.type) === 'tool-call' && asString(message.name) === 'CodexCollabCall');
    const hasWebSearchTool = forwarded.some((message) => asString(message.type) === 'tool-call' && asString(message.name) === 'CodexWebSearch');
    assert(hasSubAgentTool, 'Missing CodexSubAgent tool-call forwarding');
    assert(hasCollabTool, 'Missing CodexCollabCall tool-call forwarding');
    assert(hasWebSearchTool, 'Missing CodexWebSearch tool-call forwarding');

    const noiseSummary = noisyEvidence
        .map(({ method, count }) => `${method.replace('codex/event/', '')}:${count}`)
        .join(', ');
    console.log(`[real-log] grouped noise evidence: ${noiseSummary}`);
    console.log('[real-log] duplicate-text guard: codex delta skipped, item path emitted single agent_message');
    console.log('[real-log] visibility path: collab + web_search reach tool-call forwarding (SubAgent/CollabCall/WebSearch)');
}

main();
