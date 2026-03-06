import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@/types/api'
import { mergeSlashCommandsForDisplay } from './useSlashCommands'

function command(name: string, source: SlashCommand['source'], overrides?: Partial<SlashCommand>): SlashCommand {
    return {
        name,
        source,
        ...overrides,
    }
}

describe('mergeSlashCommandsForDisplay', () => {
    it('keeps builtin commands when RPC commands are unavailable', () => {
        const builtin = [command('status', 'builtin')]

        expect(mergeSlashCommandsForDisplay(builtin)).toEqual(builtin)
    })

    it('includes project commands from RPC results', () => {
        const builtin = [command('status', 'builtin')]
        const rpcCommands = [command('project-only', 'project', { description: 'Project command' })]

        expect(mergeSlashCommandsForDisplay(builtin, rpcCommands)).toEqual([
            command('status', 'builtin'),
            command('project-only', 'project', { description: 'Project command' }),
        ])
    })

    it('lets project commands override builtin commands with the same name', () => {
        const builtin = [command('plan', 'builtin', { description: 'Builtin plan' })]
        const rpcCommands = [command('plan', 'project', { description: 'Project plan', content: 'Project flow' })]

        expect(mergeSlashCommandsForDisplay(builtin, rpcCommands)).toEqual([
            command('plan', 'project', { description: 'Project plan', content: 'Project flow' }),
        ])
    })

    it('prefers later RPC command variants for the same name', () => {
        const builtin = [command('status', 'builtin')]
        const rpcCommands = [
            command('deploy', 'user', { description: 'Global deploy' }),
            command('deploy', 'project', { description: 'Project deploy' }),
        ]

        expect(mergeSlashCommandsForDisplay(builtin, rpcCommands)).toEqual([
            command('status', 'builtin'),
            command('deploy', 'project', { description: 'Project deploy' }),
        ])
    })
})
