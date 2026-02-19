import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTerminalFontSize } from './useTerminalFontSize'

const STORAGE_KEY = 'hapi-terminal-font-size'

function mockMatchMedia(coarse: boolean) {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: query === '(pointer: coarse)' ? coarse : false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    })
}

describe('useTerminalFontSize', () => {
    beforeEach(() => {
        localStorage.clear()
        mockMatchMedia(false)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    test('returns desktop default (13) on non-touch device', () => {
        mockMatchMedia(false)
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(13)
    })

    test('returns mobile default (11) on touch device', () => {
        mockMatchMedia(true)
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(11)
    })

    test('reads persisted value from localStorage', () => {
        localStorage.setItem(STORAGE_KEY, '15')
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(15)
    })

    test('increase increments by 1 and persists', () => {
        const { result } = renderHook(() => useTerminalFontSize())
        act(() => result.current.increase())
        expect(result.current.fontSize).toBe(14)
        expect(localStorage.getItem(STORAGE_KEY)).toBe('14')
    })

    test('decrease decrements by 1 and persists', () => {
        const { result } = renderHook(() => useTerminalFontSize())
        act(() => result.current.decrease())
        expect(result.current.fontSize).toBe(12)
        expect(localStorage.getItem(STORAGE_KEY)).toBe('12')
    })

    test('clamps at max (20)', () => {
        localStorage.setItem(STORAGE_KEY, '20')
        const { result } = renderHook(() => useTerminalFontSize())
        act(() => result.current.increase())
        expect(result.current.fontSize).toBe(20)
    })

    test('clamps at min (8)', () => {
        localStorage.setItem(STORAGE_KEY, '8')
        const { result } = renderHook(() => useTerminalFontSize())
        act(() => result.current.decrease())
        expect(result.current.fontSize).toBe(8)
    })

    test('reset removes localStorage and reverts to platform default', () => {
        localStorage.setItem(STORAGE_KEY, '16')
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(16)

        act(() => result.current.reset())
        expect(result.current.fontSize).toBe(13)
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    test('ignores invalid localStorage values', () => {
        localStorage.setItem(STORAGE_KEY, 'garbage')
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(13)
    })

    test('ignores out-of-range localStorage values', () => {
        localStorage.setItem(STORAGE_KEY, '999')
        const { result } = renderHook(() => useTerminalFontSize())
        expect(result.current.fontSize).toBe(13)
    })

    test('removes localStorage key when value equals platform default', () => {
        mockMatchMedia(false)
        localStorage.setItem(STORAGE_KEY, '14')
        const { result } = renderHook(() => useTerminalFontSize())
        // Decrease from 14 to 13 (desktop default) should remove key
        act(() => result.current.decrease())
        expect(result.current.fontSize).toBe(13)
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })
})
