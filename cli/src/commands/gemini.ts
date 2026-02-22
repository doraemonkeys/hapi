import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { applyDeferredCwd } from '@/utils/deferredCwd'
import type { CommandDefinition } from './types'
import { parseGeminiCommandArgs } from './geminiArgs'

export const geminiCommand: CommandDefinition = {
    name: 'gemini',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseGeminiCommandArgs(commandArgs)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runGemini } = await import('@/gemini/runGemini')
            applyDeferredCwd()
            await runGemini(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
