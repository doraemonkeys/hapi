import { asString } from './appServerEventConverterParsing';

type CallIdConfig = {
    scope: string;
    status: 'begin' | 'end';
    payload: Record<string, unknown>;
    generatedPrefix: string;
    fallbackScopes?: string[];
};

export class AppServerEventConverterCallIdResolver {
    private readonly codexCallIdByCorrelation = new Map<string, string>();
    private generatedCodexCallIdCounter = 0;

    resolve(config: CallIdConfig): string {
        const correlations = this.extractCorrelationIds(config.payload);
        let callId = this.extractCallId(config.payload);

        if (!callId) {
            callId = this.lookupCallId(config.scope, correlations);
        }

        if (!callId && config.fallbackScopes && config.fallbackScopes.length > 0) {
            for (const scope of config.fallbackScopes) {
                callId = this.lookupCallId(scope, correlations);
                if (callId) break;
            }
        }

        if (!callId) {
            callId = this.extractThreadFallbackCallId(config.payload);
        }

        if (!callId) {
            callId = this.generateCallId(config.generatedPrefix);
        }

        if (config.status === 'begin') {
            this.storeCallId(config.scope, callId, correlations);
        } else {
            this.deleteScopedCallId(config.scope, callId);
        }

        return callId;
    }

    reset(): void {
        this.codexCallIdByCorrelation.clear();
        this.generatedCodexCallIdCounter = 0;
    }

    private extractCorrelationIds(payload: Record<string, unknown>): string[] {
        const candidates = new Set<string>();
        const add = (value: unknown) => {
            const candidate = asString(value);
            if (candidate) {
                candidates.add(candidate);
            }
        };

        add(payload.id);
        add(payload.threadId);
        add(payload.thread_id);
        add(payload.callId);
        add(payload.call_id);
        add(payload.senderThreadId);
        add(payload.sender_thread_id);

        return [...candidates];
    }

    private extractCallId(payload: Record<string, unknown>): string | null {
        return asString(payload.call_id ?? payload.callId ?? payload.id);
    }

    private extractThreadFallbackCallId(payload: Record<string, unknown>): string | null {
        return asString(payload.threadId ?? payload.thread_id);
    }

    private storeCallId(scope: string, callId: string, correlations: string[]): void {
        for (const correlation of correlations) {
            this.codexCallIdByCorrelation.set(`${scope}:${correlation}`, callId);
        }
    }

    private lookupCallId(scope: string, correlations: string[]): string | null {
        for (const correlation of correlations) {
            const callId = this.codexCallIdByCorrelation.get(`${scope}:${correlation}`);
            if (callId) {
                return callId;
            }
        }
        return null;
    }

    private deleteScopedCallId(scope: string, callId: string): void {
        const scopePrefix = `${scope}:`;
        for (const [key, storedCallId] of this.codexCallIdByCorrelation.entries()) {
            if (storedCallId === callId && key.startsWith(scopePrefix)) {
                this.codexCallIdByCorrelation.delete(key);
            }
        }
    }

    private generateCallId(prefix: string): string {
        this.generatedCodexCallIdCounter += 1;
        return `${prefix}-${Date.now()}-${this.generatedCodexCallIdCounter}`;
    }
}
