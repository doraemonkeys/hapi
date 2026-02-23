/**
 * Centralized reconnect policy constants — single source of truth.
 *
 * Consumed by CLI socket wrappers, web socket wrappers, and SSE
 * reconnect logic. This module exports only plain values; no
 * runtime socket.io imports or stateful logic.
 */

// ---------------------------------------------------------------------------
// Socket.IO baseline options
// ---------------------------------------------------------------------------

export const RECONNECT_ENABLED = true
export const RECONNECT_ATTEMPTS = Infinity
export const RECONNECT_DELAY_MS = 1_000
export const RECONNECT_DELAY_MAX_MS = 30_000
export const RECONNECT_RANDOMIZATION_FACTOR = 0.5

// ---------------------------------------------------------------------------
// Progressive escalation thresholds
//
// After N consecutive failures the maximum backoff delay is raised to
// reduce reconnect storm pressure while still allowing eventual recovery.
// Thresholds are checked in ascending order; later entries override earlier.
// Reset to baseline on successful reconnect.
// ---------------------------------------------------------------------------

export const RECONNECT_ESCALATION_THRESHOLDS: Readonly<Record<number, number>> = {
    20: 60_000,
    50: 120_000,
}

// ---------------------------------------------------------------------------
// SSE reconnect delay constants
//
// Browser-native EventSource has no configurable backoff. SSE wrappers
// use these values to implement manual exponential backoff on reopen.
// ---------------------------------------------------------------------------

export const SSE_RECONNECT_DELAY_MS = 1_000
export const SSE_RECONNECT_DELAY_MAX_MS = 30_000
export const SSE_RECONNECT_RANDOMIZATION_FACTOR = 0.5

// ---------------------------------------------------------------------------
// Telemetry thresholds
// ---------------------------------------------------------------------------

/** Log a warning at these consecutive-failure counts (with escalating severity). */
export const RECONNECT_LOG_THRESHOLDS = [10, 50, 200] as const

/** Emit a periodic summary log every N reconnect attempts. */
export const RECONNECT_SUMMARY_INTERVAL = 25
