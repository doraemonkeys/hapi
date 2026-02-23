import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import spawn from 'cross-spawn';

export const isWindows = (): boolean => process.platform === 'win32';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessWindows(pid: number, force: boolean): boolean {
  const args = ['/T', '/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync('taskkill', args, { stdio: 'pipe' });
    if (result.error) {
      return false;
    }
    return result.status === 0;
  } catch {
    return false;
  }
}

export async function killProcess(pid: number, force: boolean = false): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  if (isWindows()) {
    return killProcessWindows(pid, force);
  }

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    await waitForProcessToDie(pid, force);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collects all descendant PIDs of a process (depth-first).
 * Returns PIDs in child-first order (leaves first, root last).
 */
function collectProcessTree(pid: number): number[] {
  const pids: number[] = [];

  try {
    const result = spawn.sync('pgrep', ['-P', pid.toString()], { encoding: 'utf8' });
    if (result.stdout) {
      const childPids = result.stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const childPid of childPids) {
        pids.push(...collectProcessTree(childPid));
      }
    }
  } catch {
    // pgrep may not be available
  }

  pids.push(pid);
  return pids;
}

/**
 * Kills a process and all its descendants.
 * Signals are sent synchronously (children first) to work in exit handlers,
 * then waits asynchronously for processes to die.
 */
async function killProcessTree(pid: number, force: boolean): Promise<boolean> {
  // Collect all PIDs first (sync) - returns in child-first order
  const pids = collectProcessTree(pid);

  // Signal all processes synchronously (children first, then root)
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch {
      // Process may have already exited
    }
  }

  // Wait for processes to die (async) - wait for root last
  for (const p of pids) {
    await waitForProcessToDie(p, force);
  }

  return true;
}

/**
 * Waits for a process to die, escalating to SIGKILL if SIGTERM doesn't work.
 */
async function waitForProcessToDie(pid: number, force: boolean): Promise<void> {
  const maxWait = 2000;
  const pollInterval = 20;
  let waited = 0;

  while (isProcessAlive(pid) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  // If SIGTERM didn't work and we haven't tried SIGKILL yet, escalate
  if (!force && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
    waited = 0;
    while (isProcessAlive(pid) && waited < 1000) {
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;
    }
  }
}

export async function killProcessByChildProcess(
  child: ChildProcess,
  force: boolean = false
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) {
    return false;
  }

  if (isWindows()) {
    // Windows taskkill /T already kills the entire process tree
    return killProcess(pid, force);
  }

  // Kill entire process tree on Unix to prevent orphan processes
  return killProcessTree(pid, force);
}

/**
 * Returns the number of direct descendant processes for a given PID.
 * Used as a safety valve: agents running long builds spawn compiler/bundler
 * child processes, so a non-zero descendant count indicates active work.
 *
 * Linux: reads /proc/<pid>/children (cgroup-aware) with pgrep fallback.
 * Windows: queries WMI via Get-CimInstance (single PowerShell call).
 * Returns 0 on any error (process dead, permission denied, unsupported OS).
 */
export function getDescendantCount(pid: number): number {
    if (!Number.isFinite(pid) || pid <= 0) {
        return 0;
    }

    // Fast path: avoid expensive OS queries for PIDs that are already gone.
    // This keeps idle checks responsive on Windows where process tree queries
    // can be slow or unavailable on some hosts.
    if (!isProcessAlive(pid)) {
        return 0;
    }

    if (isWindows()) {
        return getDescendantCountWindows(pid);
    }

    return getDescendantCountLinux(pid);
}

function getDescendantCountLinux(pid: number): number {
    // Try /proc/<pid>/task/<tid>/children first (available with CONFIG_PROC_CHILDREN)
    try {
        const taskPath = `/proc/${pid}/task`;
        const tids = readdirSync(taskPath);
        let count = 0;
        for (const tid of tids) {
            try {
                const childrenContent = readFileSync(`${taskPath}/${tid}/children`, 'utf8').trim();
                if (childrenContent) {
                    count += childrenContent.split(/\s+/).filter(Boolean).length;
                }
            } catch {
                // children file may not exist for this tid
            }
        }
        if (count > 0) {
            return count;
        }
    } catch {
        // /proc not available or no permission
    }

    // Fallback: pgrep -P (same tool already used by collectProcessTree)
    try {
        const result = spawn.sync('pgrep', ['-P', pid.toString()], { encoding: 'utf8' });
        if (result.stdout) {
            return result.stdout.trim().split('\n').filter(Boolean).length;
        }
    } catch {
        // pgrep not available
    }

    return 0;
}

function getDescendantCountWindows(pid: number): number {
    const WINDOWS_PROCESS_TREE_QUERY_TIMEOUT_MS = 1_500;

    try {
        const result = spawn.sync(
            'powershell',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -Property ProcessId).Count`
            ],
            { encoding: 'utf8', timeout: WINDOWS_PROCESS_TREE_QUERY_TIMEOUT_MS }
        );
        if (result.error || result.status !== 0) {
            return 0;
        }
        const count = parseInt(result.stdout.trim(), 10);
        return Number.isFinite(count) ? count : 0;
    } catch {
        return 0;
    }
}

/**
 * Resident memory (RSS) in bytes for a given PID, or null if unavailable.
 *
 * Linux: reads VmRSS from /proc/<pid>/status (zero shell overhead).
 * Windows: batches one or more PIDs into a single Get-Process call and
 *          returns WorkingSet64 values. Use the batch overload to amortize
 *          PowerShell cold-start cost across many tracked sessions.
 */
export function getProcessMemory(pid: number): number | null;
export function getProcessMemory(pids: number[]): Map<number, number | null>;
export function getProcessMemory(pidOrPids: number | number[]): number | null | Map<number, number | null> {
    const pids = Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids];
    if (pids.length === 0) {
        return Array.isArray(pidOrPids) ? new Map() : null;
    }

    const results = isWindows()
        ? getProcessMemoryWindows(pids)
        : getProcessMemoryLinux(pids);

    if (Array.isArray(pidOrPids)) {
        return results;
    }
    return results.get(pids[0]!) ?? null;
}

function getProcessMemoryLinux(pids: number[]): Map<number, number | null> {
    const results = new Map<number, number | null>();
    for (const pid of pids) {
        try {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
            if (match) {
                results.set(pid, parseInt(match[1]!, 10) * 1024);
            } else {
                results.set(pid, null);
            }
        } catch {
            results.set(pid, null);
        }
    }
    return results;
}

function getProcessMemoryWindows(pids: number[]): Map<number, number | null> {
    const results = new Map<number, number | null>();
    for (const pid of pids) {
        results.set(pid, null);
    }

    const pidList = pids.join(',');
    try {
        const result = spawn.sync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                `Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | Select-Object Id, WorkingSet64 | ConvertTo-Json -Compress`
            ],
            { encoding: 'utf8', timeout: 10_000 }
        );
        if (result.error || result.status !== 0 || !result.stdout.trim()) {
            return results;
        }

        // PowerShell returns a single object when only one result, array otherwise
        const parsed = JSON.parse(result.stdout.trim());
        const entries: Array<{ Id: number; WorkingSet64: number }> = Array.isArray(parsed)
            ? parsed
            : [parsed];

        for (const entry of entries) {
            if (typeof entry.Id === 'number' && typeof entry.WorkingSet64 === 'number') {
                results.set(entry.Id, entry.WorkingSet64);
            }
        }
    } catch {
        // Parse/spawn failure — return nulls
    }

    return results;
}
