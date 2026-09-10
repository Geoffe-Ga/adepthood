import { randomBytes } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  isoDaysAgo,
  readReturnState,
  reachReturnEligibility,
  signUp,
  tokenFor,
  type ReleasedHabit,
} from './journalHabitsBrowserSupport';
import { freshLicenseKey } from './licenseKey';

/**
 * Taking a habit up again after the Return that set it down has been left.
 *
 * Letting a habit rest inside a Return is a soft pause, and the card that
 * offered the pause lives inside the arc -- so leaving the arc used to carry
 * the only visible way back off with it. `POST /metta-return/arc/recommit`
 * resolved the *active* arc, which a left arc is not, so the route answered 404
 * and the resting habit could be recovered only by long-pressing a locked tile.
 * The route now spans the caller's arcs and `ReturnRestingCard` stands outside
 * the arc to press it. Both halves are green on their own -- the backend suites
 * pin the route across a left arc, and `ReturnRestingCard.test.tsx` /
 * `ReturnStack.test.tsx` pin the card against a mocked `useMettaReturn` -- and
 * neither knows whether the card's press reaches the route on a real account
 * whose arc is gone. That stitch is what this spec exists for.
 *
 * It runs in the browser lane and not the API lane because the journey is the
 * card. The recovery affordance renders only on a Journal shelf whose arc has
 * ended while a release is still outstanding, and the API lane runs on the node
 * environment with `node_modules` untransformed: it cannot mount a React Native
 * screen at all, so a spec there could only POST the route by hand and would
 * prove the server works and nothing about the way back.
 *
 * What the browser presses is deliberately only the recovery. Beginning a
 * Return from the entry is its own journey with its own spec
 * (`journal-return-offer.browser.e2e.test.ts`), and the let-go card that
 * releases habits renders only in the session that started the arc, so
 * arranging release-then-leave through the UI would mean re-driving that
 * journey to reach this one. The arrange goes over the same live wire instead,
 * and every step of it is asserted: an arrange that silently did nothing fails
 * where it happened rather than leaving the press below to test an empty shelf.
 */

/** The habit that gets set down, named so the card can be read back by it. */
const HABIT_NAME = 'Evening stillness';

/**
 * How long ago the habit started.
 *
 * Far enough back that its start date has arrived, which is what makes it a
 * live candidate for the program's own auto-reveal on every collection read --
 * so the read below that finds it still locked is finding the Return's release
 * holding it there, not merely an invitation that has not come due.
 */
const HABIT_START_DAYS_AGO = 30;

/**
 * An id inside the schema's range that names no row.
 *
 * `bounds.RowIdField` caps a body-carried id at `INT32_MAX`, so this is the
 * largest id the request schema accepts: rejected for being absent, never for
 * being malformed.
 */
const NO_SUCH_HABIT = 2_147_483_647;

/** The passphrase the wire-only account signs up with; the browser account has its own. */
const INTRUDER_PHRASE = 'Return-recovery-browser-passphrase';
const INTRUDER_TIMEZONE = 'UTC';

const OK = 200;
const CREATED = 201;

/** One habit as `GET /habits/` projects it, with the flag the Return moves. */
interface ListedHabit {
  id: number;
  name: string;
  revealed: boolean;
}

/** An account, and the habit it set down inside a Return it has since left. */
interface RestingArrangement {
  token: string;
  habitId: number;
}

/** The habit body both the create and the later manual re-lock send in full. */
function habitPayload(revealed: boolean): Record<string, unknown> {
  return {
    name: HABIT_NAME,
    icon: '★',
    start_date: isoDaysAgo(HABIT_START_DAYS_AGO),
    energy_cost: 2,
    energy_return: 4,
    revealed,
  };
}

/**
 * Read one habit back through the collection route.
 *
 * The collection read, not the point read: `GET /habits/` reconciles every
 * unconsumed auto-reveal invitation before it answers, so reading the pause
 * through it is what shows the release outranking the program's own schedule
 * rather than merely outliving a read that never looked.
 */
async function readHabit(
  request: APIRequestContext,
  token: string,
  habitId: number,
): Promise<ListedHabit> {
  const response = await request.get(`${backendUrl()}/habits/`, { headers: bearer(token) });
  expect(response.status()).toBe(OK);
  const listed = (await response.json()) as ListedHabit[];
  const habit = listed.find((row) => row.id === habitId);
  if (habit === undefined) {
    throw new Error(`habit ${String(habitId)} is missing from the account's own habit list`);
  }
  return habit;
}

/** Re-commit a batch over the wire, as a caller other than the browser's own. */
async function recommitOverTheWire(
  request: APIRequestContext,
  token: string,
  habitIds: number[],
): Promise<ReleasedHabit[]> {
  const response = await request.post(`${backendUrl()}/metta-return/arc/recommit`, {
    headers: bearer(token),
    data: { habit_ids: habitIds },
  });
  expect(response.status()).toBe(OK);
  return (await response.json()) as ReleasedHabit[];
}

/** Register an account without a browser: the second tenant needs no screen. */
async function signUpOverTheWire(
  request: APIRequestContext,
  prefix: string,
): Promise<{ email: string; token: string }> {
  const email = `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
  const response = await request.post(`${backendUrl()}/auth/signup`, {
    data: {
      email,
      password: INTRUDER_PHRASE,
      timezone: INTRUDER_TIMEZONE,
      license_key: freshLicenseKey(),
    },
  });
  expect(response.status()).toBe(OK);
  return { email, token: ((await response.json()) as { token: string }).token };
}

/** Open a Return arc for an account already carried into the stage that offers one. */
async function startArc(request: APIRequestContext, token: string): Promise<void> {
  const started = await request.post(`${backendUrl()}/metta-return/arc`, {
    headers: bearer(token),
  });
  expect(started.status()).toBe(CREATED);
}

/**
 * Sign up, unlock a habit, set it down inside a Return, and leave the arc.
 *
 * Every step is read back before the next one leans on it: the habit is
 * genuinely unlocked before the release (a locked habit is skipped silently, so
 * a release that found one would return an empty list and leave the shelf with
 * nothing to recover), genuinely locked after it, and the arc is genuinely gone
 * while the release is still outstanding. Reaching Orange is asserted false
 * before and true after inside `reachReturnEligibility`.
 */
async function setDownAHabitAndLeaveTheArc(
  page: Page,
  prefix: string,
): Promise<RestingArrangement> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);

  const created = await page.request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: habitPayload(true),
  });
  expect(created.status()).toBe(OK);
  const habitId = ((await created.json()) as { id: number }).id;
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(true);

  await reachReturnEligibility(page.request, token, email);
  await startArc(page.request, token);

  const released = await page.request.post(`${backendUrl()}/metta-return/arc/release`, {
    headers: bearer(token),
    data: { habit_ids: [habitId] },
  });
  expect(released.status()).toBe(OK);
  expect((await released.json()) as ReleasedHabit[]).toEqual([
    expect.objectContaining({ habit_id: habitId, name: HABIT_NAME, recommitted: false }),
  ]);
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(false);

  const left = await page.request.post(`${backendUrl()}/metta-return/arc/leave`, {
    headers: bearer(token),
  });
  expect(left.status()).toBe(OK);

  // The arc is over and the habit is still resting: the state the shelf has to
  // offer a way back from, and the state that used to strand it.
  const state = await readReturnState(page.request, token);
  expect(state.arc).toBeNull();
  expect(state.released_habits).toEqual([
    expect.objectContaining({ habit_id: habitId, recommitted: false }),
  ]);

  return { token, habitId };
}

/** Press the card's way back, and hold the browser to the response the server sent. */
async function takeTheHabitUpAgain(page: Page, habitId: number): Promise<void> {
  const recommitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/metta-return/arc/recommit',
  );
  await page.getByTestId(`return-recommit-${String(habitId)}`).click();
  expect((await recommitted).status()).toBe(OK);
}

test('a habit set down in a Return is taken up again once the arc is left', async ({ page }) => {
  const { token, habitId } = await setDownAHabitAndLeaveTheArc(page, 'return-recover');

  await page.reload();
  await expect(page.getByTestId('return-resting-card')).toBeVisible();
  // The row names the habit the server said was resting, so the card is showing
  // this account's own pause rather than any row that happened to render.
  await expect(page.getByTestId(`return-recommit-${String(habitId)}`)).toContainText(HABIT_NAME);

  await takeTheHabitUpAgain(page, habitId);

  // The card exists only while something rests, so a recovery that took leaves
  // no card behind -- and one that only looked like it took would leave the row.
  await expect(page.getByTestId('return-resting-card')).toHaveCount(0);

  const state = await readReturnState(page.request, token);
  expect(state.released_habits).toEqual([
    expect.objectContaining({ habit_id: habitId, recommitted: true }),
  ]);
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(true);

  // The release row recorded the re-commit, not merely the habit. `recommitted`
  // is reported as "stamped OR the habit is unlocked", so a hand-lock is the one
  // probe that can tell those apart: lock the habit from Habit Settings and the
  // second half goes false. Were the stamp missing, the Return would claim the
  // habit back and offer a way out of a pause nobody made.
  const relocked = await page.request.put(`${backendUrl()}/habits/${String(habitId)}`, {
    headers: bearer(token),
    data: habitPayload(false),
  });
  expect(relocked.status()).toBe(OK);
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(false);
  expect((await readReturnState(page.request, token)).released_habits).toEqual([
    expect.objectContaining({ habit_id: habitId, recommitted: true }),
  ]);
});

test("the way back is only the resting habit owner's to press", async ({ page }) => {
  const { token, habitId } = await setDownAHabitAndLeaveTheArc(page, 'return-recover-tenant');

  // The second account holds an arc of its own, so the 404 that guards a caller
  // who never opened one cannot be what refuses it: the refusal under test is
  // ownership of the habit named in the body.
  const intruder = await signUpOverTheWire(page.request, 'return-recover-intruder');
  await reachReturnEligibility(page.request, intruder.token, intruder.email);
  await startArc(page.request, intruder.token);

  const reachedFor = await recommitOverTheWire(page.request, intruder.token, [habitId]);
  const invented = await recommitOverTheWire(page.request, intruder.token, [NO_SUCH_HABIT]);
  // Enumeration-safe: somebody else's habit reads exactly like a habit that
  // does not exist, and neither leaves the intruder holding a release.
  expect(reachedFor).toEqual([]);
  expect(invented).toEqual(reachedFor);

  // The owner's pause is untouched by that -- and, pressed by the owner, moves,
  // so "untouched" is a refusal rather than a route that moves nothing at all.
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(false);
  await page.reload();
  await takeTheHabitUpAgain(page, habitId);
  expect((await readHabit(page.request, token, habitId)).revealed).toBe(true);
});
