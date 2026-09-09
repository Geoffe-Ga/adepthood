import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, habits, setTokenGetter } from '@/api';
import type { ApiHabitWithGoals } from '@/api';

/**
 * A timed writing session kept as a habit, at the position the writer chose.
 *
 * The offer's own rules — one-tap decline, a decline that is never re-asked,
 * the preview of which stage each habit lands on — are pinned by the Jest
 * specs beside `WritingSessionOffer`, and those specs agree with themselves about
 * a server that is not there. Three things this feature rests on are the
 * server's to answer, and only this lane can ask:
 *
 *   - that `PUT /habits/{habit_id}` KEEPS `sort_order` and `stage` rather than
 *     replacing them with the schema defaults (`sort_order=null`, `stage=""`),
 *     which is what it did before those two fields joined the payload;
 *   - that `GET /habits/` then returns the rows in the order those numbers
 *     name, so a cold rehydrate reads back the order the writer arranged
 *     rather than insertion order;
 *   - that a habit created from this offer arrives LOCKED, so the writer opens
 *     it deliberately instead of finding it already running.
 *
 * The stage names are written out rather than derived from
 * `features/Habits/services/habitOrdering`: that module reaches
 * `design/tokens` for `STAGE_ORDER`, which imports `react-native`, and this
 * lane runs on node with `node_modules` untransformed. The derivation itself is
 * covered by `habitOrdering.test.ts`; what is at stake here is whether the
 * server hands these values back.
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const ISO_DATE_LENGTH = 10;

const ENERGY = 5;
/** Far enough ahead that no clock skew between this process and the server reaches it. */
const DAYS_AHEAD = 60;
const ICON = '\u{2728}';
const JOURNALING_ICON = '\u{1F4D3}';

const email = `e2e-journal-habit-${randomUUID()}${EMAIL_DOMAIN}`;
const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);

/** The habits the writer had already signed up for, and the stages they held. */
const EXISTING = ['Meditate', 'Walk'];
const EXISTING_STAGES = ['Beige', 'Purple'];

/** What the list becomes once Journaling takes the first position. */
const PLACED = ['Journaling', ...EXISTING];
const PLACED_STAGES = ['Beige', 'Purple', 'Red'];

/** The habit payload every step here sends, varying only name, stage and place. */
function habitAt(name: string, stage: string, sortOrder: number) {
  return {
    name,
    icon: ICON,
    start_date: today,
    energy_cost: ENERGY,
    energy_return: ENERGY,
    stage,
    sort_order: sortOrder,
  };
}

describe('a timed writing session kept as a habit, against a live server', () => {
  let sessionToken: string | null = null;
  const existingIds: number[] = [];

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

  it('starts from the two habits the writer had already signed up for', async () => {
    for (const [index, name] of EXISTING.entries()) {
      const created = await habits.create(habitAt(name, EXISTING_STAGES[index] ?? '', index));
      existingIds.push(created.id);
    }

    const listed: ApiHabitWithGoals[] = await habits.listAll();

    expect(listed.map((habit) => habit.name)).toEqual(EXISTING);
    expect(listed.map((habit) => habit.stage)).toEqual(EXISTING_STAGES);
  });

  it('creates Journaling at the first position and moves the others along', async () => {
    const created = await habits.create({
      ...habitAt(PLACED[0] ?? '', PLACED_STAGES[0] ?? '', 0),
      icon: JOURNALING_ICON,
      revealed: false,
    });

    expect(created.stage).toBe('Beige');
    expect(created.sort_order).toBe(0);
    // Created locked, like every other new habit.
    expect(created.revealed).toBe(false);

    // One fan-out, as the write itself does it: every displaced row carries both
    // its new place and the stage that place names.
    await Promise.all(
      existingIds.map((id, index) =>
        habits.update(
          id,
          habitAt(EXISTING[index] ?? '', PLACED_STAGES[index + 1] ?? '', index + 1),
        ),
      ),
    );
  });

  it('serves the new order back, so a cold rehydrate reads what the writer arranged', async () => {
    const listed: ApiHabitWithGoals[] = await habits.listAll();

    expect(listed.map((habit) => habit.name)).toEqual(PLACED);
    expect(listed.map((habit) => habit.stage)).toEqual(PLACED_STAGES);
    expect(listed.map((habit) => habit.sort_order)).toEqual([0, 1, 2]);
  });

  /**
   * What actually happens to the lock, which is NOT what the issue assumed.
   *
   * The row is created locked — asserted on the POST response above, and by the
   * Jest specs on `buildAddedHabit`. It does not STAY locked, and this lane is
   * the only place that could have said so: `reconcile_habit_auto_reveals`
   * (`backend/src/services/habit_auto_reveal.py`) opens any non-carryover habit
   * whose start date has arrived OR whose stage the writer has already reached,
   * once, on the next `GET /habits/`. Placing at Beige is stage 1, which every
   * account has reached, so the invitation arrives immediately.
   *
   * That is the program's own invitation rather than anything this offer asks
   * for — the same reconciliation the `habits.calendar-auto-reveal-once`
   * journey covers, applied identically to every habit added at a stage the
   * writer is already past. Nothing is checked in on their behalf.
   *
   * The second habit here is what keeps that claim from being vacuous: a stage
   * the writer has not reached, dated ahead, is left locked by the same pass.
   */
  it('opens it because Beige is a stage the writer has reached, not because the offer asked', async () => {
    const ahead = new Date();
    ahead.setUTCDate(ahead.getUTCDate() + DAYS_AHEAD);
    const unreached = await habits.create({
      ...habitAt('Far Rung', 'Clear Light', PLACED.length),
      start_date: ahead.toISOString().slice(0, ISO_DATE_LENGTH),
      revealed: false,
    });

    const listed: ApiHabitWithGoals[] = await habits.listAll();

    expect(listed.find((habit) => habit.name === PLACED[0])?.revealed).toBe(true);
    expect(listed.find((habit) => habit.id === unreached.id)?.revealed).toBe(false);
  });
});
