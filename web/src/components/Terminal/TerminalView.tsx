import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { ensureBuiltinFontLoaded, getFontProvider } from '@/lib/terminalFont'

function resolveThemeColors(): { background: string; foreground: string; selectionBackground: string } {
    const styles = getComputedStyle(document.documentElement)
    const background = styles.getPropertyValue('--app-bg').trim() || '#000000'
    const foreground = styles.getPropertyValue('--app-fg').trim() || '#ffffff'
    const selectionBackground = styles.getPropertyValue('--app-subtle-bg').trim() || 'rgba(255, 255, 255, 0.2)'
    return { background, foreground, selectionBackground }
}

const DEFAULT_FONT_SIZE = 13

function isTouchDevice(): boolean {
    if (typeof window === 'undefined') {
        return false
    }

    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

export function TerminalView(props: {
    onMount?: (terminal: Terminal) => void
    onResize?: (cols: number, rows: number) => void
    fontSize?: number
    className?: string
}) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const onMountRef = useRef(props.onMount)
    const onResizeRef = useRef(props.onResize)
    const fontSizeRef = useRef(props.fontSize ?? DEFAULT_FONT_SIZE)

    useEffect(() => {
        onMountRef.current = props.onMount
    }, [props.onMount])

    useEffect(() => {
        onResizeRef.current = props.onResize
    }, [props.onResize])

    // Keep fontSizeRef in sync for initial creation
    fontSizeRef.current = props.fontSize ?? DEFAULT_FONT_SIZE

    // Update font size in-place when prop changes (after initial mount)
    useEffect(() => {
        const terminal = terminalRef.current
        const fitAddon = fitAddonRef.current
        if (!terminal || !fitAddon) return

        const size = props.fontSize ?? DEFAULT_FONT_SIZE
        if (terminal.options.fontSize === size) return

        terminal.options.fontSize = size
        fitAddon.fit()
        onResizeRef.current?.(terminal.cols, terminal.rows)
    }, [props.fontSize])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const abortController = new AbortController()

        const fontProvider = getFontProvider()
        const { background, foreground, selectionBackground } = resolveThemeColors()
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: fontProvider.getFontFamily(),
            fontSize: fontSizeRef.current,
            theme: {
                background,
                foreground,
                cursor: foreground,
                selectionBackground
            },
            convertEol: true,
            customGlyphs: true
        })

        const fitAddon = new FitAddon()
        const webLinksAddon = new WebLinksAddon()
        const shouldEnableTouchEnhancements = isTouchDevice()
        // Keep canvas renderer on desktop for performance; touch devices get DOM renderer.
        const useCanvas = !shouldEnableTouchEnhancements
        const canvasAddon = useCanvas ? new CanvasAddon() : null
        terminal.loadAddon(fitAddon)
        terminal.loadAddon(webLinksAddon)
        if (canvasAddon) terminal.loadAddon(canvasAddon)
        terminal.open(container)

        terminalRef.current = terminal
        fitAddonRef.current = fitAddon

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                fitAddon.fit()
                onResizeRef.current?.(terminal.cols, terminal.rows)
            })
        })
        observer.observe(container)

        let disposeTouchEnhancements: (() => void) | null = null
        if (shouldEnableTouchEnhancements && terminal.element) {
            const viewport = terminal.element.querySelector<HTMLElement>('.xterm-viewport')
            if (viewport) {
                terminal.element.classList.add('hapi-touch-terminal')
                viewport.style.setProperty('-webkit-overflow-scrolling', 'touch')
                viewport.style.touchAction = 'pan-y'

                let lastTouchY: number | null = null
                const resolveLineHeight = () => {
                    const firstRow = terminal.element?.querySelector<HTMLElement>('.xterm-rows > div')
                    const measuredHeight = firstRow?.getBoundingClientRect().height
                    const configuredFontSize = terminal.options.fontSize ?? DEFAULT_FONT_SIZE
                    return Math.max(measuredHeight ?? configuredFontSize * 1.35, 1)
                }

                const handleTouchStart = (event: TouchEvent) => {
                    if (event.touches.length !== 1) {
                        lastTouchY = null
                        return
                    }
                    lastTouchY = event.touches[0].clientY
                }

                const handleTouchMove = (event: TouchEvent) => {
                    if (lastTouchY === null || event.touches.length !== 1) {
                        return
                    }

                    const currentY = event.touches[0].clientY
                    const deltaY = currentY - lastTouchY
                    const lineHeight = resolveLineHeight()
                    const lineDelta = Math.trunc((-deltaY) / lineHeight)
                    if (lineDelta === 0) {
                        return
                    }

                    terminal.scrollLines(lineDelta)
                    lastTouchY = currentY
                    event.preventDefault()
                }

                const resetTouchTracking = () => {
                    lastTouchY = null
                }

                viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
                viewport.addEventListener('touchmove', handleTouchMove, { passive: false })
                viewport.addEventListener('touchend', resetTouchTracking, { passive: true })
                viewport.addEventListener('touchcancel', resetTouchTracking, { passive: true })

                const scrollbarTrack = document.createElement('div')
                scrollbarTrack.className = 'hapi-terminal-scrollbar-track'
                const scrollbarThumb = document.createElement('div')
                scrollbarThumb.className = 'hapi-terminal-scrollbar-thumb'
                scrollbarTrack.appendChild(scrollbarThumb)
                container.appendChild(scrollbarTrack)

                const updateScrollbar = () => {
                    const buffer = terminal.buffer.active
                    const maxScroll = Math.max(buffer.baseY, 0)
                    if (maxScroll === 0) {
                        scrollbarTrack.style.opacity = '0'
                        scrollbarTrack.style.pointerEvents = 'none'
                        return
                    }

                    scrollbarTrack.style.opacity = '1'
                    scrollbarTrack.style.pointerEvents = 'auto'

                    const trackHeight = scrollbarTrack.getBoundingClientRect().height
                    if (trackHeight <= 0) {
                        return
                    }

                    const viewportRows = Math.max(terminal.rows, 1)
                    const bufferLength = Math.max(buffer.length, viewportRows)
                    const thumbHeight = Math.max((viewportRows / bufferLength) * trackHeight, 32)
                    const maxThumbTop = Math.max(trackHeight - thumbHeight, 1)
                    const thumbTop = Math.round((buffer.viewportY / maxScroll) * maxThumbTop)

                    scrollbarThumb.style.height = `${Math.round(thumbHeight)}px`
                    scrollbarThumb.style.transform = `translateY(${thumbTop}px)`
                }

                let dragging = false
                const scrollToPointer = (clientY: number) => {
                    const buffer = terminal.buffer.active
                    const maxScroll = Math.max(buffer.baseY, 0)
                    if (maxScroll === 0) {
                        return
                    }

                    const bounds = scrollbarTrack.getBoundingClientRect()
                    const thumbHeight = scrollbarThumb.getBoundingClientRect().height
                    const maxThumbTop = Math.max(bounds.height - thumbHeight, 1)
                    const desiredThumbTop = Math.min(
                        Math.max(clientY - bounds.top - thumbHeight / 2, 0),
                        maxThumbTop
                    )
                    const ratio = desiredThumbTop / maxThumbTop
                    terminal.scrollToLine(Math.round(ratio * maxScroll))
                }

                const handlePointerDown = (event: PointerEvent) => {
                    dragging = true
                    scrollbarTrack.setPointerCapture(event.pointerId)
                    scrollToPointer(event.clientY)
                    event.preventDefault()
                }

                const handlePointerMove = (event: PointerEvent) => {
                    if (!dragging) {
                        return
                    }
                    scrollToPointer(event.clientY)
                    event.preventDefault()
                }

                const handlePointerEnd = (event: PointerEvent) => {
                    dragging = false
                    if (scrollbarTrack.hasPointerCapture(event.pointerId)) {
                        scrollbarTrack.releasePointerCapture(event.pointerId)
                    }
                }

                scrollbarTrack.addEventListener('pointerdown', handlePointerDown)
                scrollbarTrack.addEventListener('pointermove', handlePointerMove)
                scrollbarTrack.addEventListener('pointerup', handlePointerEnd)
                scrollbarTrack.addEventListener('pointercancel', handlePointerEnd)

                const scrollDisposable = terminal.onScroll(updateScrollbar)
                const resizeScrollbarObserver = new ResizeObserver(() => updateScrollbar())
                resizeScrollbarObserver.observe(container)
                requestAnimationFrame(updateScrollbar)

                disposeTouchEnhancements = () => {
                    scrollDisposable.dispose()
                    resizeScrollbarObserver.disconnect()
                    scrollbarTrack.removeEventListener('pointerdown', handlePointerDown)
                    scrollbarTrack.removeEventListener('pointermove', handlePointerMove)
                    scrollbarTrack.removeEventListener('pointerup', handlePointerEnd)
                    scrollbarTrack.removeEventListener('pointercancel', handlePointerEnd)
                    scrollbarTrack.remove()
                    viewport.removeEventListener('touchstart', handleTouchStart)
                    viewport.removeEventListener('touchmove', handleTouchMove)
                    viewport.removeEventListener('touchend', resetTouchTracking)
                    viewport.removeEventListener('touchcancel', resetTouchTracking)
                    terminal.element?.classList.remove('hapi-touch-terminal')
                }
            }
        }

        const refreshFont = (forceRemeasure = false) => {
            if (abortController.signal.aborted) return
            const nextFamily = fontProvider.getFontFamily()

            if (forceRemeasure && terminal.options.fontFamily === nextFamily) {
                terminal.options.fontFamily = `${nextFamily}, "__hapi_font_refresh__"`
                requestAnimationFrame(() => {
                    if (abortController.signal.aborted) return
                    terminal.options.fontFamily = nextFamily
                    if (terminal.rows > 0) {
                        terminal.refresh(0, terminal.rows - 1)
                    }
                    fitAddon.fit()
                    onResizeRef.current?.(terminal.cols, terminal.rows)
                })
                return
            }

            terminal.options.fontFamily = nextFamily
            if (terminal.rows > 0) {
                terminal.refresh(0, terminal.rows - 1)
            }
            fitAddon.fit()
            onResizeRef.current?.(terminal.cols, terminal.rows)
        }

        void ensureBuiltinFontLoaded().then(loaded => {
            if (!loaded) return
            refreshFont(true)
        })

        // Cleanup on abort
        abortController.signal.addEventListener('abort', () => {
            observer.disconnect()
            terminalRef.current = null
            fitAddonRef.current = null
            disposeTouchEnhancements?.()
            fitAddon.dispose()
            webLinksAddon.dispose()
            canvasAddon?.dispose()
            terminal.dispose()
        })

        requestAnimationFrame(() => {
            fitAddon.fit()
            onResizeRef.current?.(terminal.cols, terminal.rows)
        })
        onMountRef.current?.(terminal)

        return () => abortController.abort()
    }, [])

    return (
        <div
            ref={containerRef}
            className={`relative h-full w-full ${props.className ?? ''}`}
        />
    )
}
