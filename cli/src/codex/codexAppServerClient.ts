import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import type {
    InitializeParams,
    InitializeResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnInterruptParams,
    TurnInterruptResponse
} from './appServerTypes';

type JsonRpcLiteRequest = {
    id: number;
    method: string;
    params?: unknown;
};

type JsonRpcLiteNotification = {
    method: string;
    params?: unknown;
};

type JsonRpcLiteResponse = {
    id: number | string | null;
    result?: unknown;
    error?: {
        code?: number;
        message: string;
        data?: unknown;
    };
};

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function createAbortError(): Error {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    return error;
}

export class CodexAppServerClient {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connected = false;
    private connectPromise: Promise<void> | null = null;
    private buffer = '';
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private protocolError: Error | null = null;

    static readonly DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

    /**
     * Resolve the full path to the `codex` binary.
     *
     * Tool version managers (mise, nvm, volta) inject PATH entries via shell
     * hooks that are absent in non-interactive contexts (compiled binaries,
     * services, cmd.exe via `shell: true`).  We try `where`/`which` first,
     * then fall back to well-known locations so the spawn doesn't fail with
     * "'codex' is not recognized".
     */
    private static resolveCodexBinary(): string {
        // 1. Try the OS lookup command
        try {
            const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
            const result = execSync(cmd, { encoding: 'utf8', timeout: 5_000 }).trim();
            const first = result.split(/\r?\n/)[0];
            if (first && existsSync(first)) {
                return first;
            }
        } catch {
            // not in PATH — try fallback locations
        }

        // 2. Probe well-known locations (mise, volta, nvm, global npm/yarn)
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        const isWin = process.platform === 'win32';
        const bin = isWin ? 'codex.cmd' : 'codex';

        const candidates = [
            // mise shims
            process.env.MISE_SHIMS_DIR && join(process.env.MISE_SHIMS_DIR, bin),
            join(home, '.local', 'share', 'mise', 'shims', bin),
            isWin && join(home, 'AppData', 'Local', 'mise', 'shims', bin),
            // volta
            process.env.VOLTA_HOME && join(process.env.VOLTA_HOME, 'bin', bin),
            join(home, '.volta', 'bin', bin),
            // fnm / nvm (Windows)
            process.env.FNM_MULTISHELL_PATH && join(process.env.FNM_MULTISHELL_PATH, bin),
            process.env.NVM_SYMLINK && join(process.env.NVM_SYMLINK, bin),
            // global npm on Windows
            isWin && join(home, 'AppData', 'Roaming', 'npm', bin),
            // global npm on Unix
            !isWin && '/usr/local/bin/codex',
        ].filter(Boolean) as string[];

        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }

        // 3. Scan mise node version directories (codex installed as global npm
        //    package lands in the node version bin dir, not in mise shims)
        const miseNodeDirs = [
            isWin && join(home, 'AppData', 'Local', 'mise', 'installs', 'node'),
            join(home, '.local', 'share', 'mise', 'installs', 'node'),
        ].filter(Boolean) as string[];

        for (const miseNodeDir of miseNodeDirs) {
            if (!existsSync(miseNodeDir)) continue;
            try {
                const versions = readdirSync(miseNodeDir).sort().reverse();
                for (const version of versions) {
                    const codexCmd = join(miseNodeDir, version, bin);
                    if (existsSync(codexCmd)) return codexCmd;
                    // also try without .cmd extension on Windows
                    if (isWin) {
                        const codexExe = join(miseNodeDir, version, 'codex');
                        if (existsSync(codexExe)) return codexExe;
                    }
                }
            } catch {}
        }

        // 4. Give up — let the spawn fail with a clear error
        return 'codex';
    }

    /** Clone process.env for child process isolation. */
    private static cloneEnv(): Record<string, string> {
        return { ...process.env } as Record<string, string>;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.connectPromise = this.doConnect();
        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    private async doConnect(): Promise<void> {
        const codexBin = CodexAppServerClient.resolveCodexBinary();
        const env = CodexAppServerClient.cloneEnv();

        this.process = spawn(codexBin, ['app-server'], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length > 0) {
                logger.debug(`[CodexAppServer][stderr] ${text}`);
            }
        });

        this.process.on('exit', (code, signal) => {
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending(new Error(message));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.process.on('error', (error) => {
            logger.debug('[CodexAppServer] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending(new Error(
                `Failed to spawn codex app-server: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected');
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        const response = await this.sendRequest('initialize', params, { timeoutMs: 30_000 });
        this.sendNotification('initialized');
        return response as InitializeResponse;
    }

    async startThread(params: ThreadStartParams, options?: { signal?: AbortSignal }): Promise<ThreadStartResponse> {
        const response = await this.sendRequest('thread/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadStartResponse;
    }

    async resumeThread(params: ThreadResumeParams, options?: { signal?: AbortSignal }): Promise<ThreadResumeResponse> {
        const response = await this.sendRequest('thread/resume', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadResumeResponse;
    }

    async startTurn(params: TurnStartParams, options?: { signal?: AbortSignal }): Promise<TurnStartResponse> {
        const response = await this.sendRequest('turn/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as TurnStartResponse;
    }

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        const response = await this.sendRequest('turn/interrupt', params, {
            timeoutMs: 30_000
        });
        return response as TurnInterruptResponse;
    }

    async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        const child = this.process;
        this.process = null;

        try {
            child?.stdin.end();
            if (child) {
                await killProcessByChildProcess(child);
            }
        } catch (error) {
            logger.debug('[CodexAppServer] Error while stopping process', error);
        } finally {
            this.rejectAllPending(new Error('Codex app-server disconnected'));
            this.connected = false;
            this.resetParserState();
        }

        logger.debug('[CodexAppServer] Disconnected');
    }

    private async sendRequest(
        method: string,
        params?: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<unknown> {
        if (!this.connected) {
            await this.connect();
        }

        const id = this.nextId++;
        const payload: JsonRpcLiteRequest = {
            id,
            method,
            params
        };

        const timeoutMs = options?.timeoutMs ?? CodexAppServerClient.DEFAULT_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | null = null;
            let aborted = false;

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                if (options?.signal) {
                    options.signal.removeEventListener('abort', onAbort);
                }
            };

            const onAbort = () => {
                if (aborted) return;
                aborted = true;
                this.pending.delete(id);
                cleanup();
                reject(createAbortError());
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            if (Number.isFinite(timeoutMs)) {
                timeout = setTimeout(() => {
                    if (this.pending.has(id)) {
                        this.pending.delete(id);
                        cleanup();
                        reject(new Error(`Codex app-server request '${method}' timed out after ${timeoutMs}ms`));
                    }
                }, timeoutMs);
                timeout.unref();
            }

            this.pending.set(id, {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                cleanup
            });

            this.writePayload(payload);
        });
    }

    private sendNotification(method: string, params?: unknown): void {
        const payload: JsonRpcLiteNotification = { method, params };
        this.writePayload(payload);
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
                this.handleLine(line);
            }

            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    private handleLine(line: string): void {
        if (this.protocolError) {
            return;
        }

        let message: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(line);
            message = asRecord(parsed);
            if (!message) {
                logger.debug('[CodexAppServer] Ignoring non-object JSON from stdout', { line });
                return;
            }
        } catch (error) {
            const protocolError = new Error('Failed to parse JSON from codex app-server');
            this.protocolError = protocolError;
            logger.debug('[CodexAppServer] Failed to parse JSON line', { line, error });
            this.rejectAllPending(protocolError);
            this.process?.stdin.end();
            return;
        }

        if (typeof message.method === 'string') {
            const method = message.method;
            const params = 'params' in message ? message.params : null;

            if ('id' in message && message.id !== undefined) {
                const requestId = message.id;
                void this.handleIncomingRequest({
                    id: requestId,
                    method,
                    params
                });
                return;
            }

            this.notificationHandler?.(method, params ?? null);
            return;
        }

        if ('id' in message) {
            this.handleResponse(message as JsonRpcLiteResponse);
        }
    }

    private async handleIncomingRequest(request: { id: unknown; method: string; params?: unknown }): Promise<void> {
        const responseId = typeof request.id === 'number' || typeof request.id === 'string'
            ? request.id
            : null;
        const handler = this.requestHandlers.get(request.method);

        if (!handler) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`
                }
            } satisfies JsonRpcLiteResponse);
            return;
        }

        try {
            const result = await handler(request.params ?? null);
            this.writePayload({
                id: responseId,
                result
            } satisfies JsonRpcLiteResponse);
        } catch (error) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal error'
                }
            } satisfies JsonRpcLiteResponse);
        }
    }

    private handleResponse(response: JsonRpcLiteResponse): void {
        if (response.id === null || response.id === undefined) {
            logger.debug('[CodexAppServer] Received response without id');
            return;
        }

        if (typeof response.id !== 'number') {
            logger.debug('[CodexAppServer] Received response with non-numeric id', response.id);
            return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
            logger.debug('[CodexAppServer] Received response with no pending request', response.id);
            return;
        }

        this.pending.delete(response.id);

        if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
        }

        pending.resolve(response.result);
    }

    private writePayload(payload: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteResponse): void {
        const serialized = JSON.stringify(payload);
        this.process?.stdin.write(`${serialized}\n`);
    }

    private resetParserState(): void {
        this.buffer = '';
        this.protocolError = null;
    }

    private rejectAllPending(error: Error): void {
        for (const { reject, cleanup } of this.pending.values()) {
            cleanup();
            reject(error);
        }
        this.pending.clear();
    }
}
