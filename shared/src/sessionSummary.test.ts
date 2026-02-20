import { describe, expect, it } from 'bun:test'
import { getDisplayTitle } from './sessionSummary'

describe('getDisplayTitle', () => {
    const sessionId = '1234567890abcdef'

    it('uses metadata fields in priority order', () => {
        expect(getDisplayTitle({
            name: 'Named session',
            summary: { text: 'Summary title' },
            titleHint: 'First user message',
            path: '/work/repo'
        }, sessionId)).toBe('Named session')

        expect(getDisplayTitle({
            summary: { text: 'Summary title' },
            titleHint: 'First user message',
            path: '/work/repo'
        }, sessionId)).toBe('Summary title')

        expect(getDisplayTitle({
            titleHint: 'First user message',
            path: '/work/repo'
        }, sessionId)).toBe('First user message')

        expect(getDisplayTitle({
            path: '/work/repo'
        }, sessionId)).toBe('repo')
    })

    it('returns the last segment for Windows paths', () => {
        expect(getDisplayTitle({
            path: 'C:\\foo\\bar'
        }, sessionId)).toBe('bar')
    })

    it('returns the last segment for Unix paths', () => {
        expect(getDisplayTitle({
            path: '/foo/bar'
        }, sessionId)).toBe('bar')
    })

    it('returns the last segment for mixed separator paths', () => {
        expect(getDisplayTitle({
            path: 'C:\\foo/bar'
        }, sessionId)).toBe('bar')
    })

    it('falls back to session id prefix when metadata is missing', () => {
        expect(getDisplayTitle(undefined, sessionId)).toBe('12345678')
        expect(getDisplayTitle(null, sessionId)).toBe('12345678')
    })
})
