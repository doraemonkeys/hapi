/**
 * Runner diagnostics types and collection.
 *
 * Provides a compact snapshot of runner health: own memory, child session
 * memory, reconnect telemetry, and session cap utilization. Queried via
 * the /diagnostics control server endpoint and displayed by `hapi doctor`.
 */

import type { ReconnectStatsEntry } from '@/api/socketReconnectPolicy';

export interface SessionMemoryEntry {
    pid: number;
    sessionId: string | null;
    rssBytes: number | null;
}

export interface RunnerDiagnostics {
    /** Runner process own memory stats. */
    runner: {
        pid: number;
        rssBytes: number;
        heapUsedBytes: number;
        heapTotalBytes: number;
        externalBytes: number;
        uptimeSeconds: number;
    };
    /** Per-session child process memory. */
    sessions: SessionMemoryEntry[];
    /** Active session count vs configured cap. */
    sessionCap: {
        active: number;
        max: number;
    };
    /** Reconnect telemetry for all active sockets. */
    reconnect: ReconnectStatsEntry[];
}
