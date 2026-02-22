import { describe, expect, it } from 'vitest'
import { parseGeminiCommandArgs } from './geminiArgs'

describe('parseGeminiCommandArgs', () => {
    it('parses runner resume options', () => {
        const result = parseGeminiCommandArgs([
            '--resume', 'session-123',
            '--hapi-starting-mode', 'remote',
            '--started-by', 'runner',
            '--model', 'gemini-2.5-pro',
            '--yolo'
        ])

        expect(result).toEqual({
            resumeSessionId: 'session-123',
            startingMode: 'remote',
            startedBy: 'runner',
            model: 'gemini-2.5-pro',
            permissionMode: 'yolo'
        })
    })

    it('throws when --resume has no value', () => {
        expect(() => parseGeminiCommandArgs(['--resume'])).toThrow('Missing --resume value')
    })
})
