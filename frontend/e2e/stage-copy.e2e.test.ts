import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';
import { freshLicenseKey } from './licenseKey';

import { auth, setTokenGetter, stages } from '@/api';
import type { Stage } from '@/api';
import { stageCenterCellLabel } from '@/features/Map/stageLegend';

/**
 * The stage-copy journey: the two-word label a traveller reads under a stage's
 * name is the one the curriculum table holds, all the way through.
 *
 * The seam is `coursestage` row -> `GET /stages` -> the string on screen. Every
 * surface that shows it -- the Map modal, the Map's centre-cell accessibility
 * label, the magnifier caption, the Course cover -- interpolates
 * `stage.subtitle` verbatim from this route, and nothing is hardcoded
 * client-side. That is correct, and it is also why asserting a literal at both
 * ends would prove nothing: a route that stopped reading the table and answered
 * with its own copy of the seeded words would keep such a spec green.
 *
 * So this spec never names a subtitle of its own. It reads the table's answer
 * out of band and requires the client to have surfaced that, then rewrites one
 * row to a string the curriculum has never contained and requires the client to
 * follow it there. The rewrite is the assertion that matters: it can only pass
 * if the response was read from the row.
 *
 * The arrange is out of band because stage copy is seeded, never posted -- no
 * request schema accepts a subtitle, so no HTTP call can move one. Only the
 * arrange goes around the wire; every read under assertion goes through the
 * unmocked production client, which is the half this lane exists to exercise.
 * The row is put back before the file ends, so no later journey inherits it.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();

const COPY_MODULE = 'tests.e2e.stage_copy';

const SHOW_COMMAND = 'show';
const SET_SUBTITLE_COMMAND = 'set-subtitle';

/**
 * The stage whose subtitle this spec rewrites.
 *
 * Mid-arc on purpose: a client that answered from the first or the last row
 * regardless of what was asked would still look right on one of the ends.
 */
const REWRITTEN_STAGE = 5;

const email = `e2e-stage-copy-${randomUUID()}${EMAIL_DOMAIN}`;

/**
 * A subtitle no seeder wrote and no other journey uses.
 *
 * The curriculum's own subtitles are short ontological phrases; this one cannot
 * collide with any of them, so a client that surfaces it can only have read it
 * from the row this spec wrote.
 */
const SENTINEL_SUBTITLE = `Rewritten Yes-And-Ness ${randomUUID()}`;

/** The copy fields `tests.e2e.stage_copy` prints for one `coursestage` row. */
interface StageCopyRow {
  stage_number: number;
  title: string;
  subtitle: string;
}

/** The `show` subcommand's payload: every stage's copy, in stage order. */
interface StageCopyListing {
  stages: StageCopyRow[];
}

let cachedDatabaseUrl: string | null = null;

/** The throwaway database this run owns, which the out-of-band arrange reads and writes. */
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

/** Run the backend copy module against the lane database and return its one JSON line. */
function stageCopy(args: readonly string[]): string {
  const result = spawnSync(pythonExecutable(), ['-m', COPY_MODULE, ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: laneDatabaseUrl() },
  });
  if (result.status !== 0) {
    throw new Error(
      `${COPY_MODULE} ${args.join(' ')} exited ${String(result.status)}: ` +
        `${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** Every stage's copy as the table holds it, read without going near the server. */
function readStageCopy(): StageCopyRow[] {
  return (JSON.parse(stageCopy([SHOW_COMMAND])) as StageCopyListing).stages;
}

/** Write one stage's subtitle directly into the table, and report the row back. */
function writeSubtitle(stageNumber: number, subtitle: string): StageCopyRow {
  return JSON.parse(
    stageCopy([SET_SUBTITLE_COMMAND, '--stage', String(stageNumber), '--subtitle', subtitle]),
  ) as StageCopyRow;
}

/** The stage the client served under `stageNumber`, refusing a listing without it. */
function servedStage(listing: readonly Stage[], stageNumber: number): Stage {
  const stage = listing.find((candidate) => candidate.stage_number === stageNumber);
  if (stage === undefined) {
    throw new Error(`GET /stages served no stage numbered ${String(stageNumber)}`);
  }
  return stage;
}

/** The copy fields of a served stage, in the shape the table reports them. */
function servedCopy(listing: readonly Stage[]): StageCopyRow[] {
  return [...listing]
    .sort((a, b) => a.stage_number - b.stage_number)
    .map((stage) => ({
      stage_number: stage.stage_number,
      title: stage.title,
      subtitle: stage.subtitle,
    }));
}

describe('stage copy against a live server', () => {
  let sessionToken: string | null = null;
  let seeded: StageCopyRow | null = null;

  afterAll(() => {
    // The lane shares one database across every journey in the run, so the
    // rewritten row goes back even if an assertion above ended the file early.
    if (seeded !== null) writeSubtitle(seeded.stage_number, seeded.subtitle);
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

  it('serves the copy the curriculum table holds, stage for stage', async () => {
    const rows = readStageCopy();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.subtitle.length).toBeGreaterThan(0);
    }

    const listing = await stages.listAll();

    // The table's own answer, not a literal: a subtitle typed into this file
    // would agree with a route that had stopped reading the row.
    expect(servedCopy(listing)).toEqual(rows);

    seeded = rows.find((row) => row.stage_number === REWRITTEN_STAGE) ?? null;
    expect(seeded).not.toBeNull();
  });

  it('follows the row when the curriculum says something new', async () => {
    const written = writeSubtitle(REWRITTEN_STAGE, SENTINEL_SUBTITLE);
    expect(written.subtitle).toBe(SENTINEL_SUBTITLE);

    const listing = await stages.listAll();

    // The assertion the journey exists for. A client or a route answering with
    // its own copy of the seeded words passes every test above and fails here.
    expect(servedStage(listing, REWRITTEN_STAGE).subtitle).toBe(SENTINEL_SUBTITLE);
    // And it moved one stage's copy, not the whole list's.
    expect(listing.filter((stage) => stage.subtitle === SENTINEL_SUBTITLE)).toHaveLength(1);
  });

  it("reads the table's words out in the label the Map speaks", async () => {
    const stage = servedStage(await stages.listAll(), REWRITTEN_STAGE);

    // `stageCenterCellLabel` is the function `MapScreen` hands its centre-cell
    // `accessibilityLabel`, so this is the sentence a screen reader says --
    // assembled here from what the server served, which came from the row.
    const spoken = stageCenterCellLabel(stage.title, stage.subtitle, {
      locked: false,
      current: true,
    });

    expect(spoken).toBe(`${stage.title} - ${SENTINEL_SUBTITLE}, current`);
  });

  it("puts the curriculum's own words back", async () => {
    if (seeded === null) throw new Error('the seeded subtitle was never captured');

    const restored = writeSubtitle(seeded.stage_number, seeded.subtitle);
    expect(restored.subtitle).toBe(seeded.subtitle);

    const listing = await stages.listAll();

    expect(servedStage(listing, REWRITTEN_STAGE).subtitle).toBe(seeded.subtitle);
    expect(listing.filter((stage) => stage.subtitle === SENTINEL_SUBTITLE)).toHaveLength(0);
  });
});
