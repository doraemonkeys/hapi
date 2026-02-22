import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { appendFileSync } from 'node:fs';
import { AcpStdioTransport, type AcpStderrError } from './AcpStdioTransport';
import { AcpMessageHandler } from './AcpMessageHandler';
import { logger } from '@/ui/logger';
import { withRetry } from '@/utils/time';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

// #region DEBUG
const DEBUG_LOG_PATH = 'E:\\Doraemon\\IT\\Repository\\z_fork\\hapi\\.claude\\debug.log';

function debugSerialize(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable]';
    }
}

function writeDebugLog(line: string): void {
    try {
        appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // Best-effort debug logging only.
    }
}
// #endregion DEBUG

export class AcpSdkBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private isProcessingMessage = false;
    private responseCompleteResolvers: Array<() => void> = [];

    /** Retry configuration for ACP initialization */
    private static readonly INIT_RETRY_OPTIONS = {
        maxAttempts: 3,
        minDelay: 1000,
        maxDelay: 5000
    };

    constructor(private readonly options: { command: string; args?: string[]; env?: Record<string, string> }) {}

    async initialize(): Promise<void> {
        if (this.transport) return;

        this.transport = new AcpStdioTransport({
            command: this.options.command,
            args: this.options.args,
            env: this.options.env
        });

        this.transport.onNotification((method, params) => {
            if (method === 'session/update') {
                this.handleSessionUpdate(params);
            }
        });

        this.transport.onStderrError((error) => {
            this.stderrErrorHandler?.(error);
        });

        this.transport.registerRequestHandler('session/request_permission', async (params, requestId) => {
            return await this.handlePermissionRequest(params, requestId);
        });

        const response = await withRetry(
            () => this.transport!.sendRequest('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false
                },
                clientInfo: {
                    name: 'hapi',
                    version: packageJson.version
                }
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] Initialize attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        if (!isObject(response) || typeof response.protocolVersion !== 'number') {
            throw new Error('Invalid initialize response from ACP agent');
        }

        logger.debug(`[ACP] Initialized with protocol version ${response.protocolVersion}`);
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/new attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            throw new Error('Invalid session/new response from ACP agent');
        }

        this.activeSessionId = sessionId;
        return sessionId;
    }

    async loadSession(config: AgentSessionConfig & { sessionId: string }): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/load', {
                sessionId: config.sessionId,
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/load attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const loadedSessionId = isObject(response) ? asString(response.sessionId) : null;
        const sessionId = loadedSessionId ?? config.sessionId;
        this.activeSessionId = sessionId;
        return sessionId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        this.activeSessionId = sessionId;
        this.messageHandler = new AcpMessageHandler(onUpdate);
        this.isProcessingMessage = true;
        // #region DEBUG
        writeDebugLog(`[DEBUG H3] prompt:start sessionId=${sessionId} contentCount=${content.length}`);
        // #endregion DEBUG

        try {
            // No timeout for prompt requests - they can run for extended periods
            // during complex tasks, tool-heavy operations, or slow model responses
            const response = await this.transport.sendRequest('session/prompt', {
                sessionId,
                prompt: content
            }, { timeoutMs: Infinity });

            const stopReason = isObject(response) ? asString(response.stopReason) : null;
            if (stopReason) {
                this.messageHandler?.flushText();
                onUpdate({ type: 'turn_complete', stopReason });
            }
            // #region DEBUG
            writeDebugLog(`[DEBUG H3] prompt:response sessionId=${sessionId} stopReason=${stopReason ?? 'null'}`);
            // #endregion DEBUG
        } finally {
            this.messageHandler?.flushText();
            this.messageHandler = null;
            this.isProcessingMessage = false;
            this.notifyResponseComplete();
            // #region DEBUG
            writeDebugLog(`[DEBUG H3] prompt:finish sessionId=${sessionId}`);
            // #endregion DEBUG
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        this.transport.sendNotification('session/cancel', { sessionId });
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        // #region DEBUG
        writeDebugLog(`[DEBUG H1] respondToPermission requestId=${request.id} hasPending=${pending ? 'yes' : 'no'} outcome=${debugSerialize(response)}`);
        // #endregion DEBUG
        if (!pending) {
            logger.debug('[ACP] No pending permission request for id', request.id);
            return;
        }

        this.pendingPermissions.delete(request.id);

        if (response.outcome === 'cancelled') {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            return;
        }

        pending.resolve({
            outcome: {
                outcome: 'selected',
                optionId: response.optionId
            }
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    onStderrError(handler: (error: AcpStderrError) => void): void {
        this.stderrErrorHandler = handler;
    }

    /**
     * Returns true if currently processing a message (prompt in progress).
     * Useful for checking if it's safe to perform session operations.
     */
    get processingMessage(): boolean {
        return this.isProcessingMessage;
    }

    /**
     * Wait for any in-progress response to complete.
     * Resolves immediately if no response is being processed.
     * Use this before performing operations that require the response to be complete,
     * like session swap or sending task_complete.
     */
    async waitForResponseComplete(): Promise<void> {
        if (!this.isProcessingMessage) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.responseCompleteResolvers.push(resolve);
        });
    }

    async disconnect(): Promise<void> {
        if (!this.transport) return;
        await this.transport.close();
        this.transport = null;
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const sessionId = asString(params.sessionId);
        if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) {
            return;
        }
        const update = params.update;
        // #region DEBUG
        const updateType = isObject(update) ? asString(update.sessionUpdate) ?? 'unknown' : 'non-object';
        writeDebugLog(`[DEBUG H2] session/update sessionId=${sessionId ?? 'null'} updateType=${updateType} hasMessageHandler=${this.messageHandler ? 'yes' : 'no'}`);
        // #endregion DEBUG
        if (!this.messageHandler) return;
        this.messageHandler.handleUpdate(update);
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const title = asString(toolCall.title) ?? undefined;
        const kind = asString(toolCall.kind) ?? undefined;
        const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined;
        const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined;
        const options = Array.isArray(params.options)
            ? params.options
                .filter((option) => isObject(option))
                .map((option, index) => ({
                    optionId: asString(option.optionId) ?? `option-${index + 1}`,
                    name: asString(option.name) ?? `Option ${index + 1}`,
                    kind: asString(option.kind) ?? 'allow_once'
                }))
            : [];

        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title,
            kind,
            rawInput,
            rawOutput,
            options
        };

        // #region DEBUG
        writeDebugLog(`[DEBUG H1] handlePermissionRequest start requestId=${toolCallId} rpcRequestId=${requestId ?? 'null'} options=${options.length}`);
        // #endregion DEBUG
        if (!this.permissionHandler) {
            logger.debug('[ACP] No permission handler registered; cancelling request');
            return { outcome: { outcome: 'cancelled' } };
        }

        return await new Promise((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
            // #region DEBUG
            writeDebugLog(`[DEBUG H1] handlePermissionRequest pending-set requestId=${toolCallId}`);
            // #endregion DEBUG
            try {
                this.permissionHandler?.(request);
            } catch (error) {
                this.pendingPermissions.delete(toolCallId);
                logger.debug('[ACP] Permission handler threw; cancelling request', error);
                resolve({ outcome: { outcome: 'cancelled' } });
            }
        });
    }

    private notifyResponseComplete(): void {
        const resolvers = this.responseCompleteResolvers;
        this.responseCompleteResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }
}
