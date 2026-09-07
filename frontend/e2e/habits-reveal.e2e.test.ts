import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { daysBeforeStage, setAnchorDaysAgo } from './programAnchor';

import { auth, habits, setTokenGetter } from '@/api';
import type { ApiHabit, ApiHabitWithGoals } from '@/api';

/**
 * The habit-reveal journey: the program calendar opens a slot, the server
 * reveals that habit once on the next read of the Habits screen, and a relock
 * is respected forever (#2576, the owner ruling of 2026-09-06 that superseded
 * #1332 / PR #1349's "nothing auto-unlocks").
 *
 * Nothing here taps "unlock". The reveal is the server's, driven by
 * `stage_authority.open_through` over the habit's 0-based partition slot, so
 * the arrange moves the program anchor out of band (see `programAnchor.ts`)
 * and every assert reads through the production client. The one write the
 * user makes is the relock, and the last test proves the server never undoes it.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const ISO_DATE_LENGTH = 10;

const ENERGY_COST = 2;
const ENERGY_RETURN = 5;
const HABIT_ICON = 'candle';

// Program slots as the client writes `sort_order`: dense from 0 on the
// non-carryover partition. Slot N is the habit for stage N + 1.
const FIRST_SLOT = 0;
const SECOND_SLOT = 1;
const THIRD_SLOT = 2;
const SLOTS = [FIRST_SLOT, SECOND_SLOT, THIRD_SLOT];
const SECOND_STAGE = 2;

const email = `e2e-habits-reveal-${randomUUID()}${EMAIL_DOMAIN}`;
// The account's timezone is UTC, so the server's "today" is this calendar day.
const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);

/** The habit sitting at `slot`, or a loud failure naming what the server returned. */
function bySlot(listed: readonly ApiHabitWithGoals[], slot: number): ApiHabitWithGoals {
  const match = listed.find((habit) => habit.sort_order === slot);
  if (match === undefined) {
    throw new Error(
      `no habit at slot ${slot}; slots were ${listed.map((h) => String(h.sort_order)).join()}`,
    );
  }
  return match;
}

/** A parseable ISO-8601 timestamp, which is what a fresh stamp must be. */
function isIsoTimestamp(value: string | null | undefined): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** The relock payload for `habit`: every field it already has, with `revealed` off. */
function relockPayload(habit: ApiHabit) {
  return {
    name: habit.name,
    icon: habit.icon,
    start_date: habit.start_date,
    energy_cost: habit.energy_cost,
    energy_return: habit.energy_return,
    sort_order: habit.sort_order,
    revealed: false,
  };
}

describe('habit reveal journey against a live server', () => {
  let sessionToken: string | null = null;
  let secondSlotStamp = '';

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

  it('creates one locked program habit per slot; creating reveals nothing', async () => {
    for (const slot of SLOTS) {
      const created = await habits.create({
        name: `E2E Slot ${slot} ${randomUUID()}`,
        icon: HABIT_ICON,
        start_date: today,
        energy_cost: ENERGY_COST,
        energy_return: ENERGY_RETURN,
        sort_order: slot,
      });

      expect(created.sort_order).toBe(slot);
      expect(created.revealed).toBe(false);
      expect(created.auto_revealed_at).toBeNull();
    }
  });

  it('reveals only the first slot while the calendar has not moved', async () => {
    // Signup provisions no progress row, and a person with none stands at the
    // first stage: exactly one slot is open.
    const listed = await habits.listAll();

    const first = bySlot(listed, FIRST_SLOT);
    expect(first.revealed).toBe(true);
    expect(isIsoTimestamp(first.auto_revealed_at)).toBe(true);

    for (const slot of [SECOND_SLOT, THIRD_SLOT]) {
      const later = bySlot(listed, slot);
      expect(later.revealed).toBe(false);
      expect(later.auto_revealed_at).toBeNull();
    }
  });

  it('reveals the second slot once the calendar opens stage two, and not the third', async () => {
    setAnchorDaysAgo(email, daysBeforeStage(SECOND_STAGE));

    const listed = await habits.listAll();

    const second = bySlot(listed, SECOND_SLOT);
    expect(second.revealed).toBe(true);
    expect(isIsoTimestamp(second.auto_revealed_at)).toBe(true);
    secondSlotStamp = second.auto_revealed_at ?? '';

    expect(bySlot(listed, FIRST_SLOT).revealed).toBe(true);
    const third = bySlot(listed, THIRD_SLOT);
    expect(third.revealed).toBe(false);
    expect(third.auto_revealed_at).toBeNull();
  });

  it('respects a relock forever: the slot the calendar already offered is never re-revealed', async () => {
    // A guard on the fixture: without it a failure above would resurface here
    // as a mismatch against the empty string instead of the real defect.
    expect(secondSlotStamp).not.toBe('');
    const before = bySlot(await habits.listAll(), SECOND_SLOT);

    const relocked = await habits.update(before.id, relockPayload(before));
    expect(relocked.revealed).toBe(false);

    // Two reads, because the first read after a relock is the tempting moment
    // for a reveal to fire again and the second proves it stays quiet.
    for (let read = 0; read < 2; read += 1) {
      const listed = await habits.listAll();
      const second = bySlot(listed, SECOND_SLOT);
      expect(second.revealed).toBe(false);
      // Byte-identical: the stamp is the one-shot marker, and a relock must
      // leave it exactly where the calendar's offer put it.
      expect(second.auto_revealed_at).toBe(secondSlotStamp);
      expect(bySlot(listed, THIRD_SLOT).revealed).toBe(false);
    }
  });
});
