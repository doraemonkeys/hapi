import { logger } from '@/ui/logger';
import type { CodexAppServerClient } from './codexAppServerClient';
import type { DiffProcessor } from './utils/diffProcessor';
import type { CodexPermissionHandler } from './utils/permissionHandler';
import type { ReasoningProcessor } from './utils/reasoningProcessor';

type CodexAbortArgs = {
    useAppServer: boolean;
    appServerClient: CodexAppServerClient | null;
    currentThreadId: string | null;
    currentTurnId: string | null;
    abortController: AbortController;
    resetQueue: () => void;
    permissionHandler: CodexPermissionHandler | null;
    reasoningProcessor: ReasoningProcessor | null;
    diffProcessor: DiffProcessor | null;
};

type CodexAbortState = {
    currentTurnId: string | null;
    abortController: AbortController;
};

export function shouldUseAppServer(): boolean {
    const useMcpServer = process.env.CODEX_USE_MCP_SERVER === '1';
    return !useMcpServer;
}

export async function performCodexAbort(args: CodexAbortArgs): Promise<CodexAbortState> {
    logger.debug('[Codex] Abort requested - stopping current task');
    let nextTurnId = args.currentTurnId;
    try {
        if (args.useAppServer && args.appServerClient) {
            if (args.currentThreadId && args.currentTurnId) {
                try {
                    await args.appServerClient.interruptTurn({
                        threadId: args.currentThreadId,
                        turnId: args.currentTurnId
                    });
                } catch (error) {
                    logger.debug('[Codex] Error interrupting app-server turn:', error);
                }
            }

            nextTurnId = null;
        }

        args.abortController.abort();
        args.resetQueue();
        args.permissionHandler?.reset();
        args.reasoningProcessor?.abort();
        args.diffProcessor?.reset();
        logger.debug('[Codex] Abort completed - session remains active');
    } catch (error) {
        logger.debug('[Codex] Error during abort:', error);
    }

    return {
        currentTurnId: nextTurnId,
        abortController: new AbortController()
    };
}
