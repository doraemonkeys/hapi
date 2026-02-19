import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-terminal-font-size'
const DESKTOP_DEFAULT = 13
const MOBILE_DEFAULT = 11
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 20
const FONT_SIZE_STEP = 1

function isBrowser(): boolean {
    return typeof window !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors (private browsing, quota exceeded)
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function isTouchDevice(): boolean {
    if (!isBrowser()) return false
    return window.matchMedia('(pointer: coarse)').matches
}

function getPlatformDefault(): number {
    return isTouchDevice() ? MOBILE_DEFAULT : DESKTOP_DEFAULT
}

function parseFontSize(raw: string | null): number | null {
    if (raw === null) return null
    const value = Number(raw)
    if (Number.isNaN(value) || value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) return null
    return value
}

function getInitialFontSize(): number {
    return parseFontSize(safeGetItem(STORAGE_KEY)) ?? getPlatformDefault()
}

export function useTerminalFontSize(): {
    fontSize: number
    increase: () => void
    decrease: () => void
    reset: () => void
} {
    const [fontSize, setFontSizeState] = useState<number>(getInitialFontSize)

    // Cross-tab sync via StorageEvent
    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            const next = parseFontSize(event.newValue) ?? getPlatformDefault()
            setFontSizeState(next)
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const persistFontSize = useCallback((size: number) => {
        if (size === getPlatformDefault()) {
            safeRemoveItem(STORAGE_KEY)
        } else {
            safeSetItem(STORAGE_KEY, String(size))
        }
    }, [])

    const increase = useCallback(() => {
        setFontSizeState(prev => {
            const next = Math.min(prev + FONT_SIZE_STEP, MAX_FONT_SIZE)
            persistFontSize(next)
            return next
        })
    }, [persistFontSize])

    const decrease = useCallback(() => {
        setFontSizeState(prev => {
            const next = Math.max(prev - FONT_SIZE_STEP, MIN_FONT_SIZE)
            persistFontSize(next)
            return next
        })
    }, [persistFontSize])

    const reset = useCallback(() => {
        safeRemoveItem(STORAGE_KEY)
        setFontSizeState(getPlatformDefault())
    }, [])

    return { fontSize, increase, decrease, reset }
}
