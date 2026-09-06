/**
 * What the review step knows, decided away from the pixels.
 *
 * Scaffolding used to be a first-run story: the modal opened on a blank list
 * and every pick was a create. A returning user runs it over habits they
 * already have, and the modal has to ask about them rather than quietly
 * appending a second, disconnected set. Three questions per habit, and only the
 * user may answer them: is it still yours, and if so, is it already part of you
 * or ready for a fresh rating.
 *
 * The answers become a `HabitMergePlan` — the shape the save already speaks —
 * so nothing here decides what happens on the wire. It decides only what the
 * user said.
 *
 * Two rules are load-bearing:
 *
 * - Every row starts KEPT. A release is a hard delete that takes the habit's
 *   goals and check-ins with it, so it must follow an explicit, confirmed
 *   choice and never a default, an oversight, or a row the modal simply failed
 *   to list.
 * - Only a row that `isServerBackedHabit` accepts may be reviewed at all. A
 *   demo placeholder and a row whose ids this device minted both name no server
 *   row, so a PUT or DELETE against one lands on nobody — or, worse, on
 *   somebody else's habit that happens to hold that number.
 */

import type { Habit, HabitDisposition, HabitMergePlan, OnboardingHabit } from '../Habits.types';
import { hasBegun } from '../services/habitMerge';
import { isServerBackedHabit } from '../services/serverIds';

/** Where a kept habit goes: onto the carryover pages, or into the new energy order. */
export type ReviewDestination = 'bring-along' | 're-rate';

/** One habit's answers, as the review step holds them while the user changes their mind. */
export interface ReviewRow {
  readonly habitId: number;
  readonly name: string;
  readonly icon: string;
  readonly keep: boolean;
  readonly destination: ReviewDestination;
}

/** The review step, ahead of the five the flow already had. */
export const REVIEW_STEP = 0;

/** The add-habits step, which is where a first run still begins. */
export const ADD_HABITS_STEP = 1;

/**
 * A re-rated habit enters the pool as a chip beside newly typed ones, and the
 * chip has to remember which row it came from -- the user can reorder it, edit
 * its icon and rate it, and at the end the plan must still say `re-rated` with
 * the server's own id rather than `new`. `OnboardingHabit.id` is a string the
 * pool uses as a React key, so the origin rides in it rather than in a parallel
 * map that a reorder or a removal could fall out of step with.
 */
const ORIGIN_PREFIX = 'existing-';

/** The pool id a re-rated chip carries for the habit it came from. */
export const poolIdFor = (habitId: number): string => `${ORIGIN_PREFIX}${habitId}`;

/** The habit a pool chip came from, or `null` for one the user typed themselves. */
export const originHabitId = (poolId: string): number | null => {
  if (!poolId.startsWith(ORIGIN_PREFIX)) return null;
  const parsed = Number(poolId.slice(ORIGIN_PREFIX.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * The habits the review step may ask about. A demo tile is fabricated content
 * the user never made, and a row minted on this device has no server row to
 * keep or release -- listing either would offer a choice the save cannot honour.
 */
export const eligibleForReview = (existing: readonly Habit[]): Habit[] =>
  existing.filter((habit) => isServerBackedHabit(habit));

/**
 * The opening state of the review step: everything kept, and each habit
 * defaulted to the destination it is already living in. A habit the user
 * carries from before the program defaults to bring-along because that is where
 * it already sits; every other habit defaults to re-rate because it is already
 * in the program lap. Neither default is a recommendation — both are just
 * "leave it where it is until you say otherwise".
 */
export const buildReviewRows = (existing: readonly Habit[]): ReviewRow[] =>
  eligibleForReview(existing).map((habit) => ({
    habitId: habit.id,
    name: habit.name,
    icon: habit.icon,
    keep: true,
    destination: habit.is_carryover === true ? 'bring-along' : 're-rate',
  }));

/** Where the flow opens: the review step when there is anything to review, else step 1. */
export const entryStepFor = (rows: readonly ReviewRow[]): number =>
  rows.length > 0 ? REVIEW_STEP : ADD_HABITS_STEP;

const replaceRow = (
  rows: readonly ReviewRow[],
  habitId: number,
  change: (_row: ReviewRow) => ReviewRow,
): ReviewRow[] => rows.map((row) => (row.habitId === habitId ? change(row) : row));

/** Flip one row between kept and released. Reversible, and reversible again. */
export const toggleKeep = (rows: readonly ReviewRow[], habitId: number): ReviewRow[] =>
  replaceRow(rows, habitId, (row) => ({ ...row, keep: !row.keep }));

/** Mark one row as released outright — what confirming a chip removal means. */
export const releaseRow = (rows: readonly ReviewRow[], habitId: number): ReviewRow[] =>
  replaceRow(rows, habitId, (row) => ({ ...row, keep: false }));

/** Choose where a kept habit goes. */
export const setDestination = (
  rows: readonly ReviewRow[],
  habitId: number,
  destination: ReviewDestination,
): ReviewRow[] => replaceRow(rows, habitId, (row) => ({ ...row, destination }));

/** The rows the user has unchecked — the ones a confirmation has to name. */
export const releasedRows = (rows: readonly ReviewRow[]): ReviewRow[] =>
  rows.filter((row) => !row.keep);

const isReRated = (row: ReviewRow): boolean => row.keep && row.destination === 're-rate';

const pickFrom = (habit: Habit): OnboardingHabit => ({
  id: poolIdFor(habit.id),
  name: habit.name,
  icon: habit.icon,
  energy_cost: habit.energy_cost,
  energy_return: habit.energy_return,
  stage: habit.stage,
  start_date: habit.start_date,
});

/**
 * The pick a re-rated habit enters the pool as. It carries the habit's stored
 * ratings, name and icon so the sliders open where the user last left them
 * rather than at the default 5, and its stored stage and start date so nothing
 * about its beginning changes before the reorder step restamps the pool.
 *
 * A habit whose beginning the user has already lived is marked as keeping it,
 * because the merge will refuse to restamp such a row and the reorder step must
 * not display a date the save is about to discard. The mark is computed with
 * the merge's own predicate so the two cannot drift apart.
 */
const programPick = (habit: Habit): OnboardingHabit => ({
  ...pickFrom(habit),
  ...(hasBegun(habit) ? { keepsOwnBeginning: true } : {}),
});

/**
 * The pick a brought-along habit is named by. It never enters the pool, so its
 * ratings are only ever read back out again -- but its `start_date` is the day
 * the user began that habit in their own life, from before the program, and
 * saying so is what keeps the program's anchor from being derived from it.
 */
const carryoverPick = (habit: Habit): OnboardingHabit => ({
  ...pickFrom(habit),
  is_carryover: true,
});

/**
 * Reconcile the pool with the review answers, without touching anything the
 * user typed.
 *
 * Called on every arrival at the add-habits step, because the user may walk
 * back to the review step and change their mind: a habit switched to
 * bring-along has to leave the pool, one switched back to re-rate has to
 * return, and a newly typed habit has to survive both. Chips the user already
 * rated keep their edits — this only adds what is missing and drops what no
 * longer belongs.
 */
export const syncPool = (
  pool: readonly OnboardingHabit[],
  rows: readonly ReviewRow[],
  existing: readonly Habit[],
): OnboardingHabit[] => {
  const wanted = new Set(rows.filter(isReRated).map((row) => row.habitId));
  const kept = pool.filter((pick) => {
    const origin = originHabitId(pick.id);
    return origin === null || wanted.has(origin);
  });
  const present = new Set(kept.map((pick) => originHabitId(pick.id)));
  const added = existing
    .filter((habit) => wanted.has(habit.id) && !present.has(habit.id))
    .map(programPick);
  return [...added, ...kept];
};

const dispositionForPick = (
  pick: OnboardingHabit,
  byId: ReadonlyMap<number, ReviewRow>,
): HabitDisposition | null => {
  const origin = originHabitId(pick.id);
  if (origin === null) return { kind: 'new', habit: pick };
  const row = byId.get(origin);
  // A chip whose row is gone, released, or no longer bound for the new order
  // says nothing here: the row's own disposition below is the one the user
  // stated, and re-POSTing the pick under a name the server still owns is the
  // 409 this whole flow exists to remove.
  if (row === undefined || !isReRated(row)) return null;
  return { kind: 're-rated', habitId: origin, habit: pick };
};

const dispositionForRow = (
  row: ReviewRow,
  existingById: ReadonlyMap<number, Habit>,
): HabitDisposition => {
  if (!row.keep) return { kind: 'released', habitId: row.habitId };
  const original = existingById.get(row.habitId);
  if (row.destination === 'bring-along' && original !== undefined) {
    return { kind: 'brought-along', habitId: row.habitId, habit: carryoverPick(original) };
  }
  // Kept, meant for the new order, and yet carrying no chip: the user took it
  // off the add-habits step without confirming a release. Nothing it holds is
  // overwritten and nothing is deleted -- the habit simply sits this lap out.
  return { kind: 'retained', habitId: row.habitId };
};

/**
 * Everything the user said, as one plan.
 *
 * Pool order comes first because it is the order the new program lap is
 * stamped in — the reveal sorted it and the reorder step let the user drag it,
 * and the stage and start date each pick carries were laid out along it. The
 * rows the pool does not carry follow in the order the user reviewed them.
 */
export const buildMergePlan = (
  pool: readonly OnboardingHabit[],
  rows: readonly ReviewRow[],
  existing: readonly Habit[],
): HabitMergePlan => {
  const rowsById = new Map(rows.map((row) => [row.habitId, row]));
  const existingById = new Map(existing.map((habit) => [habit.id, habit]));
  const fromPool = pool
    .map((pick) => dispositionForPick(pick, rowsById))
    .filter((disposition): disposition is HabitDisposition => disposition !== null);
  const pooled = new Set(
    fromPool.flatMap((disposition) => ('habitId' in disposition ? [disposition.habitId] : [])),
  );
  const fromRows = rows
    .filter((row) => !pooled.has(row.habitId))
    .map((row) => dispositionForRow(row, existingById));
  return [...fromPool, ...fromRows];
};
