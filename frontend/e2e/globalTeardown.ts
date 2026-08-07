import { spawnSync } from 'node:child_process';

import {
  BACKEND_DIR,
  clearLaneState,
  pythonExecutable,
  readLaneState,
  type LaneState,
} from './laneState';

/**
 * Take the lane back down deterministically: no server left listening, no
 * database left behind, and a loud failure if either cannot be guaranteed.
 *
 * The drop runs here rather than in the server's own `finally` because uvicorn
 * re-raises the signal that stopped it, ending the process before any cleanup
 * of its own could run. Both paths issue `DROP DATABASE IF EXISTS`, so a server
 * that did manage to clean up after itself costs this one a no-op.
 */

const SIGTERM_GRACE_MS = 10_000;
const EXIT_POLL_MS = 50;

/** Whether the process group leader is still around. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The two signals teardown sends, in escalation order. */
type StopSignal = 'SIGTERM' | 'SIGKILL';

/** Signal the whole process group, tolerating a leader that already exited. */
function signalGroup(pid: number, signal: StopSignal): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the state we wanted anyway.
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });

/** SIGTERM the group, escalating to SIGKILL if it outstays the grace period. */
async function stopServer(pid: number): Promise<void> {
  if (pid <= 0) return;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + SIGTERM_GRACE_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await wait(EXIT_POLL_MS);
  }
  if (isAlive(pid)) signalGroup(pid, 'SIGKILL');
}

/** Drop the run's database, failing loudly rather than leaking it silently. */
function dropDatabase(state: LaneState): void {
  const result = spawnSync(pythonExecutable(), ['-m', 'tests.e2e.server', '--drop-only'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: 'src',
      DATABASE_URL: state.databaseUrl,
      E2E_ADMIN_DATABASE_URL: state.adminUrl,
    },
  });
  if (result.status === 0) return;
  throw new Error(
    `could not drop the e2e database (exit ${String(result.status)}): ${result.stderr || result.stdout}`,
  );
}

export default async function globalTeardown(): Promise<void> {
  const state = readLaneState();
  if (state === null) return;
  try {
    await stopServer(state.pid);
    dropDatabase(state);
  } finally {
    clearLaneState();
  }
}
