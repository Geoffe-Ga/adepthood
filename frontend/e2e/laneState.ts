import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The handshake between `globalSetup` and `globalTeardown`, which run in the
 * same process but cannot share a closure across Jest's module boundary, and
 * between both of them and `setupEnv`, which runs in the worker.
 */
export interface LaneState {
  /** Process group leader of the server, killed as a group at teardown. */
  pid: number;
  /** Loopback origin the production client is pointed at. */
  baseUrl: string;
  /** URL of the throwaway database the run owns. */
  databaseUrl: string;
  /** URL of a database that already exists, used only to drop the throwaway one. */
  adminUrl: string;
}

/** Repository root, three levels up from `frontend/e2e`. */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Working directory the server module must be launched from. */
export const BACKEND_DIR = join(REPO_ROOT, 'backend');

/** Where the run records itself; `.gitignore`d, and removed at teardown. */
export const STATE_FILE = join(__dirname, '.e2e-state.json');

/** Write the run's coordinates so teardown can reach them. */
export function writeLaneState(state: LaneState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Read the run's coordinates, or null when setup never got far enough. */
export function readLaneState(): LaneState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as LaneState;
}

/** Forget the run, so a later invocation cannot inherit a dead server's port. */
export function clearLaneState(): void {
  rmSync(STATE_FILE, { force: true });
}

/**
 * The interpreter that can import the backend. `E2E_PYTHON` wins; otherwise the
 * repo's virtualenv if it exists (the local case), else whatever `python3` is on
 * PATH (the CI case, where dependencies are installed system-wide).
 *
 * Shared rather than duplicated: setup spawns the server with it and teardown
 * drops the database with it, and an interpreter that differed between the two
 * would leave the database behind while looking like it had cleaned up.
 */
export function pythonExecutable(): string {
  const override = process.env.E2E_PYTHON?.trim();
  if (override) return override;
  const venv = join(REPO_ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}
