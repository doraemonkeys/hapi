/**
 * Stateful reconnect-policy wrapper for CLI socket.io-client sockets.
 *
 * Listens to Manager-level reconnect events, tracks consecutive failure
 * count, and dynamically escalates `reconnectionDelayMax` at configured
 * thresholds. Resets on successful reconnect.
 *
 * Also provides threshold-based telemetry logging: warnings at escalating
 * severity, periodic summary logs, and per-socket disconnect-duration
 * tracking.
 */

import type { Socket } from 'socket.io-client'
import { logger } from '@/ui/logger'
import {
    RECONNECT_DELAY_MAX_MS,
    RECONNECT_ESCALATION_THRESHOLDS,
    RECONNECT_LOG_THRESHOLDS,
    RECONNECT_SUMMARY_INTERVAL,
} from '@hapi/protocol'

/** Sorted escalation thresholds (ascending by attempt count). */
const SORTED_THRESHOLDS = Object.entries(RECONNECT_ESCALATION_THRESHOLDS)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0])

export interface ReconnectTelemetry {
    /** Consecutive failures in the current disconnect window. */
    consecutiveFailures: number
    /** Total reconnect attempts since this policy was attached. */
    totalAttempts: number
    /** Timestamp (ms) when the current disconnect window started, or null if connected. */
    disconnectedSince: number | null
    /** Longest observed disconnect window duration (ms). */
    longestDisconnectMs: number
    /** Currently applied reconnectionDelayMax (for diagnostics). */
    currentDelayMax: number
    /** Remove this entry from the global telemetry registry. */
    dispose: () => void
}

/** Labeled snapshot for diagnostics display. */
export interface ReconnectStatsEntry {
    label: string
    telemetry: ReconnectTelemetry
}

/**
 * Global registry of active reconnect telemetry objects.
 * Each call to applySocketReconnectPolicy registers its label + telemetry here.
 * Queried by `hapi doctor` diagnostics via getReconnectStats().
 */
const activeTelemetry: ReconnectStatsEntry[] = []

/** Returns a snapshot of all active reconnect telemetry entries. */
export function getReconnectStats(): ReconnectStatsEntry[] {
    return activeTelemetry.map(entry => ({
        label: entry.label,
        telemetry: { ...entry.telemetry },
    }))
}

export function applySocketReconnectPolicy(
    socket: Socket,
    label: string,
): ReconnectTelemetry {
    const telemetry: ReconnectTelemetry = {
        consecutiveFailures: 0,
        totalAttempts: 0,
        disconnectedSince: null,
        longestDisconnectMs: 0,
        currentDelayMax: RECONNECT_DELAY_MAX_MS,
        dispose: () => {
            const idx = activeTelemetry.indexOf(entry)
            if (idx !== -1) activeTelemetry.splice(idx, 1)
        },
    }

    // Register in global registry for diagnostics querying
    const entry: ReconnectStatsEntry = { label, telemetry }
    activeTelemetry.push(entry)

    const manager = socket.io
    if (!manager || typeof manager.on !== 'function' || typeof manager.reconnectionDelayMax !== 'function') {
        logger.debug(`[${label}] Reconnect policy disabled: socket manager unavailable`)
        return telemetry
    }

    // Track the current disconnect window start
    const markDisconnected = () => {
        if (telemetry.disconnectedSince === null) {
            telemetry.disconnectedSince = Date.now()
        }
    }

    // --- reconnect_attempt: fires before each retry -----------------------
    manager.on('reconnect_attempt', (attempt: number) => {
        markDisconnected()
        telemetry.consecutiveFailures = attempt
        telemetry.totalAttempts++

        // Progressive escalation: raise delay max at thresholds
        for (const [threshold, delayMax] of SORTED_THRESHOLDS) {
            if (attempt === threshold) {
                manager.reconnectionDelayMax(delayMax)
                telemetry.currentDelayMax = delayMax
                logger.debug(
                    `[${label}] Reconnect escalation: attempt ${attempt} → delayMax ${delayMax}ms`,
                )
                break
            }
        }

        // Threshold-based alerting with escalating severity
        if (RECONNECT_LOG_THRESHOLDS.includes(attempt as typeof RECONNECT_LOG_THRESHOLDS[number])) {
            const elapsed = telemetry.disconnectedSince
                ? Math.round((Date.now() - telemetry.disconnectedSince) / 1_000)
                : 0

            if (attempt >= 200) {
                logger.warn(
                    `[${label}] Reconnect attempt ${attempt} (disconnected ${elapsed}s, delayMax ${telemetry.currentDelayMax}ms)`,
                )
            } else if (attempt >= 50) {
                logger.warn(
                    `[${label}] Reconnect attempt ${attempt} (disconnected ${elapsed}s)`,
                )
            } else {
                logger.debug(
                    `[${label}] Reconnect attempt ${attempt} (disconnected ${elapsed}s)`,
                )
            }
        }

        // Periodic summary: avoid log spam by batching
        if (
            attempt > 0 &&
            attempt % RECONNECT_SUMMARY_INTERVAL === 0 &&
            !RECONNECT_LOG_THRESHOLDS.includes(attempt as typeof RECONNECT_LOG_THRESHOLDS[number])
        ) {
            const elapsed = telemetry.disconnectedSince
                ? Math.round((Date.now() - telemetry.disconnectedSince) / 1_000)
                : 0
            logger.debug(
                `[${label}] Reconnect summary: ${telemetry.totalAttempts} total attempts, current window ${elapsed}s, longest ${Math.round(telemetry.longestDisconnectMs / 1_000)}s`,
            )
        }
    })

    // --- reconnect: successful reconnect ----------------------------------
    manager.on('reconnect', (_attempt: number) => {
        // Record longest disconnect duration
        if (telemetry.disconnectedSince !== null) {
            const duration = Date.now() - telemetry.disconnectedSince
            if (duration > telemetry.longestDisconnectMs) {
                telemetry.longestDisconnectMs = duration
            }
        }

        const prevFailures = telemetry.consecutiveFailures
        telemetry.consecutiveFailures = 0
        telemetry.disconnectedSince = null

        // Reset delay max to baseline
        manager.reconnectionDelayMax(RECONNECT_DELAY_MAX_MS)
        telemetry.currentDelayMax = RECONNECT_DELAY_MAX_MS

        if (prevFailures > 1) {
            logger.debug(
                `[${label}] Reconnected after ${prevFailures} attempts (longest disconnect ${Math.round(telemetry.longestDisconnectMs / 1_000)}s)`,
            )
        }
    })

    // --- reconnect_error: individual attempt failure ----------------------
    manager.on('reconnect_error', (err: Error) => {
        markDisconnected()
        // Only log at debug to avoid spam; threshold logs handle alerting
        logger.debug(`[${label}] Reconnect error: ${err.message}`)
    })

    return telemetry
}
