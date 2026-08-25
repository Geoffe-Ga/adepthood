import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, practices, setTokenGetter, userPractices } from '@/api';
import type { PracticeItem } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const ISO_DATE_LENGTH = 10;

const STAGE_NUMBER = 1;
const DURATION_MINUTES = 12;
const MEDITATION_TIMER = 'meditation_timer';

/**
 * The config the wizard submits: the mode's own knobs, with the bell flags
 * left off so the server has to fill its defaults in. The response is
 * compared against `NORMALISED_CONFIG` below, so a config that reached the
 * database unvalidated -- or never reached it at all -- shows up as a diff.
 */
const SUBMITTED_CONFIG = { mode: MEDITATION_TIMER, duration_minutes: DURATION_MINUTES } as const;
const NORMALISED_CONFIG = {
  ...SUBMITTED_CONFIG,
  start_bell: true,
  halfway_bell: false,
  end_bell: true,
};

const email = `e2e-practice-catalog-${randomUUID()}${EMAIL_DOMAIN}`;
const practiceName = `Vela y aliento 灯 ${randomUUID()}`;
const description = 'A practice this account wrote for itself.';
const instructions = 'Sit. Follow the breath in. Follow it out. Begin again.';
// The account's timezone is UTC, so the server's "today" is this calendar day.
const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);

/** Unwrap a collection the journey requires to hold exactly one element. */
function exactlyOne<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (items.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

function findById(items: readonly PracticeItem[], practiceId: number): PracticeItem | undefined {
  return items.find((item) => item.id === practiceId);
}

describe('custom-practice adoption journey against a live server', () => {
  let sessionToken: string | null = null;
  let practiceId = 0;
  let userPracticeId = 0;
  let startDate = '';

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

  it('submits a custom practice and gets the stored row back as a draft', async () => {
    const created = await practices.create({
      stage_number: STAGE_NUMBER,
      name: practiceName,
      description,
      instructions,
      default_duration_minutes: DURATION_MINUTES,
      mode: MEDITATION_TIMER,
      mode_config: SUBMITTED_CONFIG,
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe(practiceName);
    expect(created.description).toBe(description);
    expect(created.instructions).toBe(instructions);
    expect(created.stage_number).toBe(STAGE_NUMBER);
    expect(created.default_duration_minutes).toBe(DURATION_MINUTES);
    // A submission is a draft: only an approval flow may flip this.
    expect(created.approved).toBe(false);
    expect(created.mode).toBe(MEDITATION_TIMER);
    expect(created.mode_config).toEqual(NORMALISED_CONFIG);

    practiceId = created.id;
  });

  it('shows the draft in the catalog the way the catalog screen asks for it', async () => {
    // `includeMine` is the flag PracticeCatalogList sends. Without it the
    // submitter's own draft is invisible, which is exactly how a written
    // practice becomes one nobody can ever reach.
    const mine = await practices.listAll({ stageNumber: STAGE_NUMBER, includeMine: true });

    const draft = findById(mine, practiceId);
    expect(draft?.name).toBe(practiceName);
    expect(draft?.approved).toBe(false);
    expect(draft?.mode_config).toEqual(NORMALISED_CONFIG);
  });

  it('keeps the draft out of the approved-only listing', async () => {
    const approvedOnly = await practices.listAll({ stageNumber: STAGE_NUMBER });

    expect(findById(approvedOnly, practiceId)).toBeUndefined();
  });

  it('adopts the draft as the active practice for the stage', async () => {
    const adopted = await userPractices.create({
      practice_id: practiceId,
      stage_number: STAGE_NUMBER,
    });

    expect(adopted.id).toBeGreaterThan(0);
    expect(adopted.practice_id).toBe(practiceId);
    expect(adopted.stage_number).toBe(STAGE_NUMBER);
    expect(adopted.start_date).toBe(today);
    expect(adopted.end_date).toBeNull();

    userPracticeId = adopted.id;
    startDate = adopted.start_date;
  });

  it('reads the adoption back with the catalog name resolved onto it', async () => {
    const listed = await userPractices.list();

    const selection = exactlyOne(listed, 'user practice on the fresh account');
    expect(selection.id).toBe(userPracticeId);
    expect(selection.practice_id).toBe(practiceId);
    expect(selection.stage_number).toBe(STAGE_NUMBER);
    expect(selection.start_date).toBe(startDate);
    expect(selection.end_date).toBeNull();
    expect(selection.custom_name).toBeNull();
    // Resolved by the server across both tables: a `userpractice` row alone
    // cannot produce this name, so a broken join reads as a null here.
    expect(selection.effective_name).toBe(practiceName);
    expect(selection.effective_config).toEqual(NORMALISED_CONFIG);
  });

  it('treats a second adoption of the same practice as the same selection', async () => {
    const again = await userPractices.create({
      practice_id: practiceId,
      stage_number: STAGE_NUMBER,
    });

    // A double-tap must not mint a second row or reset the "I started this"
    // date the streak math hangs off.
    expect(again.id).toBe(userPracticeId);
    expect(again.start_date).toBe(startDate);

    const listed = await userPractices.list();
    expect(listed.map((selection) => selection.id)).toEqual([userPracticeId]);
  });
});
