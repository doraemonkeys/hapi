import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import type { McpServersConfig } from './buildHapiMcpBridge';
import { codexSystemPrompt } from './systemPrompt';
import type {
    ThreadStartParams,
    TurnStartParams
} from '../appServerTypes';
import {
    resolveCodexPermissionModeConfig,
    resolveSandboxPolicyOverride
} from './resolvePermissions';

function buildMcpServerConfig(mcpServers: McpServersConfig): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    for (const [name, server] of Object.entries(mcpServers)) {
        config[`mcp_servers.${name}`] = {
            command: server.command,
            args: server.args
        };
    }

    return config;
}

export function buildThreadStartParams(args: {
    mode: EnhancedMode;
    mcpServers: McpServersConfig;
    cliOverrides?: CodexCliOverrides;
    baseInstructions?: string;
    developerInstructions?: string;
}): ThreadStartParams {
    const permissionConfig = resolveCodexPermissionModeConfig(args.mode.permissionMode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = cliOverrides?.approvalPolicy ?? permissionConfig.approvalPolicy;
    const resolvedSandbox = cliOverrides?.sandbox ?? permissionConfig.sandbox;

    const config = buildMcpServerConfig(args.mcpServers);
    const baseInstructions = args.baseInstructions ?? codexSystemPrompt;
    const resolvedDeveloperInstructions = args.developerInstructions
        ? `${baseInstructions}\n\n${args.developerInstructions}`
        : baseInstructions;
    const configWithInstructions = {
        ...config,
        developer_instructions: resolvedDeveloperInstructions
    };

    const params: ThreadStartParams = {
        approvalPolicy: resolvedApprovalPolicy,
        sandbox: resolvedSandbox,
        baseInstructions,
        developerInstructions: resolvedDeveloperInstructions,
        ...(Object.keys(configWithInstructions).length > 0 ? { config: configWithInstructions } : {})
    };

    if (args.mode.model) {
        params.model = args.mode.model;
    }

    return params;
}

export function buildTurnStartParams(args: {
    threadId: string;
    message: string;
    mode?: EnhancedMode;
    cliOverrides?: CodexCliOverrides;
    overrides?: {
        approvalPolicy?: TurnStartParams['approvalPolicy'];
        sandboxPolicy?: TurnStartParams['sandboxPolicy'];
        model?: string;
    };
}): TurnStartParams {
    const params: TurnStartParams = {
        threadId: args.threadId,
        input: [{ type: 'text', text: args.message }]
    };

    const permissionConfig = args.mode
        ? resolveCodexPermissionModeConfig(args.mode.permissionMode)
        : undefined;
    const allowCliOverrides = args.mode?.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const approvalPolicy = args.overrides?.approvalPolicy
        ?? cliOverrides?.approvalPolicy
        ?? permissionConfig?.approvalPolicy;
    if (approvalPolicy) {
        params.approvalPolicy = approvalPolicy;
    }

    const sandboxPolicy = args.overrides?.sandboxPolicy
        ?? resolveSandboxPolicyOverride(cliOverrides?.sandbox)
        ?? permissionConfig?.sandboxPolicy;
    if (sandboxPolicy) {
        params.sandboxPolicy = sandboxPolicy;
    }

    const collaborationMode = args.mode?.collaborationMode;
    const model = args.overrides?.model ?? args.mode?.model;
    if (collaborationMode) {
        const settings = model ? { model } : undefined;
        params.collaborationMode = settings
            ? { mode: collaborationMode, settings }
            : { mode: collaborationMode };
    } else if (model) {
        params.model = model;
    }

    return params;
}
