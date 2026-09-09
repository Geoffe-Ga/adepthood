import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, practiceSessions, practices, setTokenGetter, userPractices } from '@/api';

/**
 * A timed writing session kept as the `Journaling` practice, at Green.
 *
 * The offer's own rules — one tap to decline, a decline never re-asked, the
 * sentence shown before anything is written — are pinned by the Jest specs
 * beside `WritingSessionOffer` and `SaveAsPracticeStep`, and every one of those
 * agrees with itself about a server that is not there. Four things the offer
 * rests on are the SERVER's to answer, and only this lane can ask:
 *
 *   - that the seeder actually put a `Journaling` row in the shared catalogue
 *     at stage 6, approved and selectable — the Jest specs hand themselves one;
 *   - that `POST /user-practices/` ACCEPTS that row at Green for an account
 *     standing at Beige. The whole shape of the flow turns on this: the
 *     catalogue row's stage is not negotiable (a mismatched `stage_number` is
 *     400 `stage_number_mismatch`), so if a forward-planned selection were
 *     refused there would be nothing to offer a writer below Green at all;
 *   - that `POST /practice-sessions/` against that same selection is refused
 *     with 403 `stage_locked`, which is why the client declines to send it and
 *     says so instead of discovering it as an error;
 *   - that a second selection at Green CLOSES the first rather than failing,
 *     which is precisely the silent eviction the offer names before the tap.
 *
 * The account is deliberately left at its entry stage. A fresh signup stands at
 * Beige, so this lane exercises the harder half — the half where the save
 * cannot count the session — and pins that the flow still has something honest
 * to do there.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();

/** Green, where the seeded `Journaling` row sits. */
const GREEN_STAGE = 6;
const JOURNALING = 'Journaling';
/** `frontend/src/features/Journal/writingSession.ts::DEFAULT_WRITING_MINUTES`. */
const WRITING_MINUTES = 20;
const MS_PER_MINUTE = 60_000;
const HTTP_FORBIDDEN = 403;

const email = `e2e-journal-practice-${randomUUID()}${EMAIL_DOMAIN}`;
const endedAt = new Date();
const startedAt = new Date(endedAt.getTime() - WRITING_MINUTES * MS_PER_MINUTE);

/** Unwrap a value the journey cannot continue without. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the server returned no ${what}`);
  }
  return value;
}

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('a timed writing session kept as a practice, against a live server', () => {
  let sessionToken: string | null = null;
  let journalingId = 0;
  let otherGreenId = 0;
  let otherGreenName = '';
  let selectionId = 0;

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

  it('finds the seeded Journaling row in the shared catalogue at Green', async () => {
    const catalog = await practices.listAll({ stageNumber: GREEN_STAGE });
    const journaling = required(
      catalog.find((row) => row.name === JOURNALING),
      `"${JOURNALING}" row in the stage-${GREEN_STAGE} catalogue`,
    );

    expect(journaling.stage_number).toBe(GREEN_STAGE);
    expect(journaling.approved).toBe(true);
    // The mode the writing timer's elapsed reading belongs to; no mode was added.
    expect(journaling.mode).toBe('count_up');
    expect(journaling.default_duration_minutes).toBe(WRITING_MINUTES);

    journalingId = journaling.id;
    const other = required(
      catalog.find((row) => row.name !== JOURNALING),
      `second stage-${GREEN_STAGE} practice to displace with`,
    );
    otherGreenId = other.id;
    otherGreenName = other.name;
  });

  it('keeps it at Green even though the writer is standing at Beige', async () => {
    const kept = await userPractices.create({
      practice_id: journalingId,
      stage_number: GREEN_STAGE,
    });

    expect(kept.practice_id).toBe(journalingId);
    expect(kept.stage_number).toBe(GREEN_STAGE);
    // Open, so it is the selection the offer would later name and displace.
    expect(kept.end_date).toBeNull();

    selectionId = kept.id;
  });

  it('refuses to count the session there, which is why the client never sends one', async () => {
    const failure = await rejection(
      practiceSessions.create({
        user_practice_id: selectionId,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
      }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_FORBIDDEN);
    expect((failure as ApiError).detail).toBe('stage_locked');
  });

  it('reads the open selection back by the name the offer would show', async () => {
    const selections = await userPractices.list();
    const open = required(
      selections.find((row) => row.end_date === null && row.stage_number === GREEN_STAGE),
      `open selection at stage ${GREEN_STAGE}`,
    );

    expect(open.id).toBe(selectionId);
    expect(open.effective_name).toBe(JOURNALING);
  });

  it('closes the open selection when another practice takes Green, rather than refusing', async () => {
    const replacement = await userPractices.create({
      practice_id: otherGreenId,
      stage_number: GREEN_STAGE,
    });

    expect(replacement.practice_id).toBe(otherGreenId);
    expect(replacement.id).not.toBe(selectionId);

    const selections = await userPractices.list();
    const displaced = required(
      selections.find((row) => row.id === selectionId),
      'the displaced Journaling selection',
    );

    // The eviction the offer names before the tap: silent, immediate, and the
    // only record of it is a closed row.
    expect(displaced.end_date).not.toBeNull();
    const open = selections.filter(
      (row) => row.end_date === null && row.stage_number === GREEN_STAGE,
    );
    expect(open.map((row) => row.effective_name)).toEqual([otherGreenName]);
  });
});
