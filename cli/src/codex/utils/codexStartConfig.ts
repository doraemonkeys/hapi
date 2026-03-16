import type { CodexSessionConfig } from '../types';
import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import { codexSystemPrompt } from './systemPrompt';
import { resolveCodexPermissionModeConfig } from './resolvePermissions';

export function buildCodexStartConfig(args: {
    message: string;
    mode: EnhancedMode;
    first: boolean;
    mcpServers: Record<string, { command: string; args: string[] }>;
    cliOverrides?: CodexCliOverrides;
    developerInstructions?: string;
}): CodexSessionConfig {
    const permissionConfig = resolveCodexPermissionModeConfig(args.mode.permissionMode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = cliOverrides?.approvalPolicy ?? permissionConfig.approvalPolicy;
    const resolvedSandbox = cliOverrides?.sandbox ?? permissionConfig.sandbox;

    const prompt = args.message;
    const baseInstructions = codexSystemPrompt;
    const config: Record<string, unknown> = {
        mcp_servers: args.mcpServers,
        developer_instructions: args.developerInstructions
            ? `${baseInstructions}\n\n${args.developerInstructions}`
            : baseInstructions
    };
    const startConfig: CodexSessionConfig = {
        prompt,
        sandbox: resolvedSandbox,
        'approval-policy': resolvedApprovalPolicy,
        config
    };

    if (args.mode.model) {
        startConfig.model = args.mode.model;
    }

    return startConfig;
}
