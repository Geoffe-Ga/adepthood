import { spawnSync } from 'node:child_process';

import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';

import { STAGE_DURATIONS_DAYS } from '@/constants/program';

/**
 * The out-of-band arrange for journeys that need the calendar to have moved.
 *
 * `program_started_at` is only ever written as "now" and no request schema
 * accepts it, so no HTTP call can carry an account backwards into last month.
 * These helpers rewind it against the lane's own throwaway database through a
 * backend module; every assert still goes through the production client, which
 * is the half the lane exists to exercise. Shared by the Map journey (the
 * record follows the calendar) and the habit-reveal journey (the calendar
 * offers the next habit), so the two cannot drift on how "the calendar moved"
 * is manufactured.
 */

const ANCHOR_MODULE = 'tests.e2e.program_anchor';

/** The `stageprogress` row as `tests.e2e.program_anchor` prints it. */
export interface ProgressRow {
  user_id: number;
  current_stage: number;
  completed_stages: number[];
  cycle_number: number;
  highest_stage_reached: number;
  program_started_at: string;
  stage_started_at: string;
}

let cachedDatabaseUrl: string | null = null;

/** The throwaway database this run owns, which the out-of-band arrange writes to. */
function laneDatabaseUrl(): string {
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

/** Run the backend anchor module against the lane database and parse its one JSON line. */
export function programAnchor(args: readonly string[]): ProgressRow {
  const result = spawnSync(pythonExecutable(), ['-m', ANCHOR_MODULE, ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: laneDatabaseUrl() },
  });
  if (result.status !== 0) {
    throw new Error(
      `${ANCHOR_MODULE} ${args.join(' ')} exited ${String(result.status)}: ` +
        `${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as ProgressRow;
}

/**
 * Put both of `email`'s program timestamps exactly `daysAgo` days back, touching
 * no stage number. Provisions the progress row when the account has none yet.
 */
export function setAnchorDaysAgo(email: string, daysAgo: number): ProgressRow {
  return programAnchor(['anchor', '--email', email, '--days-ago', String(daysAgo)]);
}

/** Read `email`'s persisted row without going near the server. */
export function showProgress(email: string): ProgressRow {
  return programAnchor(['show', '--email', email]);
}

/**
 * Days from the program anchor to the moment `stageNumber`'s window opens.
 *
 * Always a whole window boundary, and that is what keeps the lane off the
 * midnight edge: the arrange runs strictly before the read, so a UTC midnight
 * crossing between the two can only make the server count one day MORE than
 * asked for, never fewer. Offsetting any of these by a day would put the anchor
 * inside the previous window and hand that safety back.
 */
export function daysBeforeStage(stageNumber: number): number {
  return STAGE_DURATIONS_DAYS.slice(0, stageNumber - 1).reduce((total, days) => total + days, 0);
}
