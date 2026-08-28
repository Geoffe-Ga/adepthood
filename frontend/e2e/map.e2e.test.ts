import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';

import { auth, setTokenGetter, stages, wheel } from '@/api';
import { STAGE_DURATIONS_DAYS } from '@/constants/program';

/**
 * The Map journey: a traveller returns after the calendar has carried them into
 * a new stage, opens the Map, and the server agrees that they moved.
 *
 * Advance is not an action a person takes. The calendar over the ratified
 * 21x8 + 42x2 schedule decides what is offered, and reading the Map is what
 * records that the person entered it. There is deliberately no tap affordance,
 * so this spec moves the anchor and then reads. It never posts.
 *
 * The arrange is therefore out of band. `program_started_at` is only ever
 * written as "now" and no request schema accepts it, so no HTTP call can carry
 * an account backwards into last month. The rewind runs against the lane's own
 * throwaway database through a backend module; only the assert goes through the
 * production client, which is the half this lane exists to exercise.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

const ANCHOR_MODULE = 'tests.e2e.program_anchor';

const FIRST_STAGE = 1;
const SECOND_STAGE = 2;
const THIRD_STAGE = 3;
const FOURTH_STAGE = 4;
const FIRST_WEEK = 1;
const FIRST_CYCLE = 1;
const TOTAL_STAGES = STAGE_DURATIONS_DAYS.length;

const FULLNESS_FLOOR = 0;
const FULLNESS_CEILING = 1;

const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * MS_PER_SECOND;
// Deliberately loose. This lane shares a machine with a parallel agent fleet,
// and a tight window around "now" is a known flake source here; fifteen minutes
// still fails a `stage_started_at` that stayed on a 21-day-old anchor.
const CLOCK_TOLERANCE_SECONDS = 900;
const CLOCK_TOLERANCE_MS = CLOCK_TOLERANCE_SECONDS * MS_PER_SECOND;

const email = `e2e-map-${randomUUID()}${EMAIL_DOMAIN}`;

/** The `stageprogress` row as `tests.e2e.program_anchor` prints it. */
interface ProgressRow {
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
function programAnchor(args: readonly string[]): ProgressRow {
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

/** Put both program timestamps exactly `daysAgo` days back, touching no stage number. */
function setAnchorDaysAgo(daysAgo: number): ProgressRow {
  return programAnchor(['anchor', '--email', email, '--days-ago', String(daysAgo)]);
}

/** Read the persisted row without going near the server. */
function showProgress(): ProgressRow {
  return programAnchor(['show', '--email', email]);
}

/**
 * Days from the program anchor to the moment `stageNumber`'s window opens.
 *
 * Always a whole window boundary, and that is what keeps this lane off the
 * midnight edge: the arrange runs strictly before the read, so a UTC midnight
 * crossing between the two can only make the server count one day MORE than
 * asked for, never fewer. Offsetting any of these by a day would put the anchor
 * inside the previous window and hand that safety back.
 */
function daysBeforeStage(stageNumber: number): number {
  return STAGE_DURATIONS_DAYS.slice(0, stageNumber - 1).reduce((total, days) => total + days, 0);
}

/** Every stage number the program has, ascending. */
function stageNumbers(): number[] {
  return Array.from({ length: TOTAL_STAGES }, (_value, index) => index + FIRST_STAGE);
}

/** The `is_unlocked` column the listing must report when access reaches `stageNumber`. */
function unlockedThrough(stageNumber: number): boolean[] {
  return stageNumbers().map((number) => number <= stageNumber);
}

/** How long ago `iso` was, in milliseconds, refusing anything unparseable. */
function ageMs(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`expected an ISO-8601 timestamp, but the row holds "${iso}"`);
  }
  return Date.now() - parsed;
}

describe('map journey against a live server', () => {
  let sessionToken: string | null = null;
  let enteredAt = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('starts the program with the calendar and the record agreeing', async () => {
    // Signup provisions no progress row, and opening the Map does not create
    // one either: the read paths record entry, they do not enrol anybody.
    const dayZero = await stages.programCalendar();
    expect(dayZero.program_started_at).toBeNull();

    // So the arrange creates the row at stage 1 and anchors it today: day zero
    // of the schedule, where both answers agree.
    const arranged = setAnchorDaysAgo(daysBeforeStage(FIRST_STAGE));
    expect(arranged.current_stage).toBe(FIRST_STAGE);

    const calendar = await stages.programCalendar();

    expect(calendar.program_started_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(calendar.program_started_at ?? ''))).toBe(false);
    expect(calendar.calendar_stage).toBe(FIRST_STAGE);
    expect(calendar.calendar_week).toBe(FIRST_WEEK);
    expect(calendar.current_stage).toBe(FIRST_STAGE);
    expect(calendar.cycle_number).toBe(FIRST_CYCLE);
  });

  it('offers only the first stage while the calendar has not moved', async () => {
    const listing = await stages.listAll();

    expect(listing).toHaveLength(TOTAL_STAGES);
    expect(listing.map((stage) => stage.stage_number)).toEqual(stageNumbers());
    expect(listing.map((stage) => stage.is_unlocked)).toEqual(unlockedThrough(FIRST_STAGE));
  });

  it('moving the calendar past the first window does not by itself move the record', () => {
    const rewound = setAnchorDaysAgo(daysBeforeStage(SECOND_STAGE));
    expect(rewound.current_stage).toBe(FIRST_STAGE);

    // A database read, not a request: nothing has visited the Map since the
    // rewind, so nothing may have advanced. Only a read can move the record.
    const persisted = showProgress();

    expect(persisted.current_stage).toBe(FIRST_STAGE);
    expect(persisted.completed_stages).toEqual([]);
    expect(persisted.highest_stage_reached).toBe(FIRST_STAGE);

    const expectedAge = daysBeforeStage(SECOND_STAGE) * MS_PER_DAY;
    expect(ageMs(persisted.program_started_at)).toBeGreaterThan(expectedAge - CLOCK_TOLERANCE_MS);
    expect(ageMs(persisted.program_started_at)).toBeLessThan(expectedAge + CLOCK_TOLERANCE_MS);
  });

  it('opening the map records the entry the calendar had opened', async () => {
    const calendar = await stages.programCalendar();

    expect(calendar.calendar_stage).toBe(SECOND_STAGE);
    // The record, read back after the visit. This is the assertion that goes
    // red the moment a read path stops recording entry.
    expect(calendar.current_stage).toBe(SECOND_STAGE);

    const persisted = showProgress();

    expect(persisted.current_stage).toBe(SECOND_STAGE);
    expect(persisted.completed_stages).toEqual([FIRST_STAGE]);
    expect(persisted.highest_stage_reached).toBe(SECOND_STAGE);
    // The threshold moment: off the backdated anchor and onto roughly now.
    expect(Date.parse(persisted.stage_started_at)).toBeGreaterThan(
      Date.parse(persisted.program_started_at),
    );
    expect(Math.abs(ageMs(persisted.stage_started_at))).toBeLessThan(CLOCK_TOLERANCE_MS);

    enteredAt = persisted.stage_started_at;
  });

  it('offers the newly entered stage on the map listing', async () => {
    const listing = await stages.listAll();

    expect(listing.map((stage) => stage.is_unlocked)).toEqual(unlockedThrough(SECOND_STAGE));
    // On its own this proves only that the CALENDAR moved: access is
    // `open_through`, the union of calendar and record. The test above is what
    // proves the record moved with it.
  });

  it('records nothing further on a second read inside the same window', async () => {
    // A guard on the fixture, not a claim about the app: without it, an entry
    // test that failed above would resurface here as a baffling mismatch
    // against the empty string rather than pointing at the real defect.
    expect(enteredAt).not.toBe('');

    const calendar = await stages.programCalendar();
    expect(calendar.current_stage).toBe(SECOND_STAGE);

    const persisted = showProgress();

    // Byte-identical: a re-record inside the same window would overwrite the
    // moment the threshold was actually crossed.
    expect(persisted.stage_started_at).toBe(enteredAt);
    expect(persisted.current_stage).toBe(SECOND_STAGE);
  });

  it('carries a returning traveller into the window they walked into, not each one they missed', async () => {
    // This also resets `stage_started_at`, so nothing below may reuse the
    // moment captured two tests ago.
    setAnchorDaysAgo(daysBeforeStage(FOURTH_STAGE));

    const listing = await stages.listAll();
    expect(listing.map((stage) => stage.is_unlocked)).toEqual(unlockedThrough(FOURTH_STAGE));

    const persisted = showProgress();

    expect(persisted.current_stage).toBe(FOURTH_STAGE);
    // Contiguity is a structural invariant of the row, not a claim that the
    // traveller engaged the stages they were away for.
    expect(persisted.completed_stages).toEqual([FIRST_STAGE, SECOND_STAGE, THIRD_STAGE]);
    expect(persisted.highest_stage_reached).toBe(FOURTH_STAGE);
    expect(Math.abs(ageMs(persisted.stage_started_at))).toBeLessThan(CLOCK_TOLERANCE_MS);
  });

  it('reads the wheel the map draws its fullness from', async () => {
    const balance = await wheel.get();

    expect(balance.aspects).toHaveLength(TOTAL_STAGES);
    expect(balance.aspects.map((entry) => entry.stage_number)).toEqual(stageNumbers());
    for (const entry of balance.aspects) {
      expect(entry.aspect.length).toBeGreaterThan(0);
      expect(Number.isFinite(entry.fullness)).toBe(true);
      expect(entry.fullness).toBeGreaterThanOrEqual(FULLNESS_FLOOR);
      expect(entry.fullness).toBeLessThanOrEqual(FULLNESS_CEILING);
    }
  });
});
