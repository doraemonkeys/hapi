import type { GeminiPermissionMode } from '@hapi/protocol/types'

export type GeminiCommandOptions = {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: GeminiPermissionMode
    model?: string
    resumeSessionId?: string
}

export function parseGeminiCommandArgs(commandArgs: string[]): GeminiCommandOptions {
    const options: GeminiCommandOptions = {}

    for (let i = 0; i < commandArgs.length; i++) {
        const arg = commandArgs[i]
        if (arg === '--started-by') {
            options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
        } else if (arg === '--hapi-starting-mode') {
            const value = commandArgs[++i]
            if (value === 'local' || value === 'remote') {
                options.startingMode = value
            } else {
                throw new Error('Invalid --hapi-starting-mode (expected local or remote)')
            }
        } else if (arg === '--yolo') {
            options.permissionMode = 'yolo'
        } else if (arg === '--model') {
            const model = commandArgs[++i]
            if (!model) {
                throw new Error('Missing --model value')
            }
            options.model = model
        } else if (arg === '--resume') {
            const sessionId = commandArgs[++i]
            if (!sessionId) {
                throw new Error('Missing --resume value')
            }
            options.resumeSessionId = sessionId
        }
    }

    return options
}
