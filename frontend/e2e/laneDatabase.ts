import { spawnSync } from 'node:child_process';

import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';

/**
 * The lane's own throwaway database, and the one way a journey arranges state
 * the wire deliberately cannot write -- a moved calendar anchor, a stage's copy,
 * an operator flag -- by running a backend module against that database.
 *
 * Shared rather than restated per spec: it was once copied into each spec that
 * needed it, and a helper copied three times is a helper that drifts three ways.
 */

let cachedDatabaseUrl: string | null = null;

/** The throwaway database this run owns, which an out-of-band arrange writes to. */
export function laneDatabaseUrl(): string {
  if (cachedDatabaseUrl === null) {
    const state = readLaneState();
    if (state === null) {
      throw new Error(
        'the e2e lane wrote no state file, so this journey has no database to arrange ' +
          'against. Run the lane through "npm run test:e2e".',
      );
    }
    cachedDatabaseUrl = state.databaseUrl;
  }
  return cachedDatabaseUrl;
}

/**
 * Run ``python -m <module> <args>`` from the backend against the lane database
 * and return its stdout, throwing with its output on any non-zero exit.
 */
export function runBackendModule(module: string, args: readonly string[]): string {
  const result = spawnSync(pythonExecutable(), ['-m', module, ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: laneDatabaseUrl() },
  });
  if (result.status !== 0) {
    throw new Error(
      `${module} ${args.join(' ')} exited ${String(result.status)}: ` +
        `${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
