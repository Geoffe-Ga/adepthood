/**
 * The pure half of a re-scaffolding pass: what the onboarding picks mean for
 * the habits a user already has, and which wire calls that implies.
 *
 * Onboarding used to be a first-run-only story, so saving it was a create loop.
 * Both entry points that reopen the modal are unconditional, though, so a
 * returning user runs it over a list that already exists — and the server
 * rejects a second habit under a name the caller already owns, with a 409 the
 * create loop swallowed into a console line. The user's new rating never
 * landed, the stale row kept its old one, and nothing said so.
 *
 * Deciding that here rather than in the service is what makes it testable
 * without a store, a network or a clock; the service keeps the effects.
 *
 * Two rules in here are the load-bearing ones, and both are about what NOT to
 * do:
 *
 * - A name is matched the way the server matches it, `lower(trim(name))`,
 *   because that comparison is what decides whether a POST is a create or a
 *   409. Matching more loosely would delete a row the user meant to keep;
 *   matching more tightly puts back the swallowed 409.
 * - A row the picks never mention is RETAINED, never released. The DELETE
 *   cascades a habit's goals and completions server-side and cannot be undone,
 *   so it must follow an explicit, confirmed choice — never an omission. This
 *   module therefore never derives a `released` disposition; it only executes
 *   one a caller states.
 */

import type { HabitCreatePayload } from '../../../api';
import type {
  Goal,
  Habit,
  HabitDisposition,
  HabitMergePlan,
  OnboardingHabit,
} from '../Habits.types';
import { isNotCarryoverHabit } from '../HabitUtils';

import { isNotDemoSeed, isServerBackedHabit, isServerIssuedId } from './serverIds';

const DEFAULT_GOAL_CONFIG = {
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
};

const GOAL_TIERS = [
  { tier: 'low' as const, target: 1, label: 'Low' },
  { tier: 'clear' as const, target: 2, label: 'Clear' },
  { tier: 'stretch' as const, target: 3, label: 'Stretch' },
];

const TIERS_PER_HABIT = GOAL_TIERS.length;

/** The habit fields the API round-trips, in the shape `POST` and `PUT` share. */
export const toApiPayload = (h: Habit): HabitCreatePayload => ({
  name: h.name,
  icon: h.icon,
  start_date:
    h.start_date instanceof Date ? h.start_date.toISOString().slice(0, 10) : String(h.start_date),
  energy_cost: h.energy_cost,
  energy_return: h.energy_return,
  notification_times: h.notificationTimes ?? null,
  notification_frequency: h.notificationFrequency ?? null,
  notification_days: h.notificationDays ?? null,
  milestone_notifications: h.milestoneNotifications ?? false,
  // ``sort_order`` and ``stage`` are persisted on PUT so reorder + emoji
  // edits survive a logout/login round-trip — without these, the server
  // happily replaces the row with the schema defaults (sort_order=null,
  // stage="") and the next ``GET /habits`` returns the user's tiles in
  // insertion order with the original onboarding stage label.
  sort_order: h.sort_order ?? null,
  stage: h.stage,
  // ``revealed`` is the persisted unlock flag; default locked when absent so a
  // client that never set it does not accidentally unlock the row server-side.
  revealed: h.revealed ?? false,
  // ``is_carryover`` rides every create AND update payload so edit/delete/
  // reorder PUTs preserve the negative-lap flag without special-casing.
  is_carryover: h.is_carryover ?? false,
});

export const buildTierGoals = (habitName: string, idFor: (tierIndex: number) => number): Goal[] =>
  GOAL_TIERS.map((t, ti) => ({
    id: idFor(ti),
    title: `${t.label} goal for ${habitName}`,
    ...DEFAULT_GOAL_CONFIG,
    tier: t.tier,
    target: t.target,
  }));

/**
 * Scaffold brand-new picks into store rows so their tiles are interactive
 * immediately, before the POSTs and the trailing reload land. The ids minted
 * here are positive integers inside the server's own range, so nothing about
 * their shape distinguishes them from real ones — `hasClientMintedIds` is the
 * only thing that keeps them off the wire during that window.
 *
 * The bases exist because a re-scaffold mints alongside rows that are staying.
 * Numbering from zero again would hand a new tile the id of a habit the user
 * already has, and for the length of that window every id-keyed local action —
 * a log, an emoji edit, a goal change — would land on the wrong tile. They
 * default to zero so a first run still mints `1..n` and `1..3n`.
 */
export const buildOnboardingHabits = (
  newHabits: readonly OnboardingHabit[],
  habitIdBase = 0,
  goalIdBase = 0,
): Habit[] =>
  newHabits.map((habit, index) => ({
    ...habit,
    id: habitIdBase + index + 1,
    streak: 0,
    revealed: false,
    completions: [] as Habit['completions'],
    goals: buildTierGoals(habit.name, (ti) => goalIdBase + index * TIERS_PER_HABIT + ti + 1),
    hasClientMintedIds: true,
  }));

/**
 * How the server decides whether a name is already taken: `lower(trim(name))`,
 * scoped to the caller. Mirrored rather than approximated, because this
 * comparison is exactly what separates a create from a swallowed 409.
 */
const nameKey = (name: string): string => name.trim().toLowerCase();

const largest = (values: readonly number[]): number =>
  values.reduce((highest, value) => (value > highest ? value : highest), 0);

const habitIdCeiling = (existing: readonly Habit[]): number =>
  largest(existing.map((habit) => habit.id).filter(isServerIssuedId));

const goalIdCeiling = (existing: readonly Habit[]): number =>
  largest(existing.flatMap((habit) => habit.goals.map((goal) => goal.id)).filter(isServerIssuedId));

/** Every pick the plan carries, in plan order. */
export const pickedHabits = (plan: HabitMergePlan): OnboardingHabit[] =>
  plan.flatMap((disposition) => ('habit' in disposition ? [disposition.habit] : []));

const namedHabitIds = (plan: HabitMergePlan): Set<number> =>
  new Set(plan.flatMap((disposition) => ('habitId' in disposition ? [disposition.habitId] : [])));

const indexByName = (existing: readonly Habit[]): Map<string, Habit> => {
  const byName = new Map<string, Habit>();
  for (const habit of existing) {
    const key = nameKey(habit.name);
    if (isServerBackedHabit(habit) && !byName.has(key)) byName.set(key, habit);
  }
  return byName;
};

const keptDisposition = (match: Habit, pick: OnboardingHabit): HabitDisposition => ({
  kind: match.is_carryover === true ? 'brought-along' : 're-rated',
  habitId: match.id,
  habit: pick,
});

const retainedDispositions = (
  existing: readonly Habit[],
  claimed: ReadonlySet<number>,
): HabitDisposition[] =>
  existing
    .filter((habit) => isServerBackedHabit(habit) && !claimed.has(habit.id))
    .map((habit) => ({ kind: 'retained', habitId: habit.id }));

/**
 * Read the picks against the habits that already exist.
 *
 * This is the derivation the app runs today, because the modal builds its list
 * from scratch and hands back bare picks: nothing upstream knows which existing
 * row a pick means. A caller that does know — a modal that showed the user
 * their current habits and asked — states the plan itself and skips this.
 *
 * A pick that matches only a demo tile or a not-yet-synced row is `new`: there
 * is no server row to address, so a PUT would land on whichever real habit
 * happens to carry that fabricated number. A duplicate name in the store (which
 * the server's unique index makes impossible, but a cache from before it did
 * not) matches once and leaves the second row retained, so no row is ever
 * addressed twice in one pass.
 */
export const deriveMergePlan = (
  picks: readonly OnboardingHabit[],
  existing: readonly Habit[],
): HabitMergePlan => {
  const byName = indexByName(existing);
  const claimed = new Set<number>();
  const plan: HabitDisposition[] = [];
  for (const pick of picks) {
    const match = byName.get(nameKey(pick.name));
    if (match === undefined || claimed.has(match.id)) {
      plan.push({ kind: 'new', habit: pick });
      continue;
    }
    claimed.add(match.id);
    plan.push(keptDisposition(match, pick));
  }
  return [...plan, ...retainedDispositions(existing, claimed)];
};

/**
 * Overwrite a kept row with what the user just chose, and nothing else.
 *
 * The scaffolder cannot be reused here. It zeroes the streak, empties the
 * completions, mints fresh goal ids and sets `revealed: false` — and because
 * the update payload carries `revealed`, a PUT built from such a row would
 * re-lock, server-side and durably, a habit the user had already unlocked.
 *
 * `keepsItsOwnLap` is a carryover: the habit began in the user's life before
 * the program, so its start date is not a program date and its stage is not a
 * program stage. It takes the new rating and icon; it keeps its own beginning.
 */
const carryKept = (original: Habit, pick: OnboardingHabit, keepsItsOwnLap: boolean): Habit => ({
  ...original,
  name: pick.name,
  icon: pick.icon,
  energy_cost: pick.energy_cost,
  energy_return: pick.energy_return,
  ...(keepsItsOwnLap ? {} : { stage: pick.stage, start_date: pick.start_date }),
});

/**
 * Positional order within each partition, as the rest of the screen reads it:
 * carryover and program slots each restart at zero, so `sort_order` is only
 * meaningful after splitting by `is_carryover`.
 */
const stampSortOrder = (rows: readonly Habit[]): Habit[] => {
  let program = 0;
  let carryover = 0;
  return rows.map((row) => {
    if (isNotCarryoverHabit(row)) {
      const stamped = { ...row, sort_order: program };
      program += 1;
      return stamped;
    }
    const stamped = { ...row, sort_order: carryover };
    carryover += 1;
    return stamped;
  });
};

/** A disposition that keeps a row the store already holds. */
type KeptDisposition = Exclude<HabitDisposition, { kind: 'new' } | { kind: 'released' }>;

/** The row a kept disposition resolves to, or nothing when it names no row. */
const keptRow = (
  disposition: KeptDisposition,
  byId: ReadonlyMap<number, Habit>,
): Habit | undefined => {
  const original = byId.get(disposition.habitId);
  if (original === undefined || disposition.kind === 'retained') return original;
  return carryKept(original, disposition.habit, disposition.kind === 'brought-along');
};

const pushDefined = (rows: Habit[], row: Habit | undefined): void => {
  if (row !== undefined) rows.push(row);
};

const carriedRows = (
  plan: HabitMergePlan,
  byId: ReadonlyMap<number, Habit>,
  minted: readonly Habit[],
): Habit[] => {
  // A queue rather than an index: each `new` disposition consumes the next
  // minted row, and the two lists are built in the same order by construction.
  const minting = [...minted];
  const rows: Habit[] = [];
  for (const disposition of plan) {
    if (disposition.kind === 'new') pushDefined(rows, minting.shift());
    else if (disposition.kind !== 'released') pushDefined(rows, keptRow(disposition, byId));
  }
  return rows;
};

/**
 * A row nobody decided about survives the pass untouched — except a demo tile,
 * which is fabricated content that has to go the moment the user has habits of
 * their own. Without this, a plan that simply forgot a row would drop it from
 * the store, which reads to the user as a habit deleting itself.
 */
const unmentionedRows = (existing: readonly Habit[], named: ReadonlySet<number>): Habit[] =>
  existing.filter((habit) => !named.has(habit.id) && isNotDemoSeed(habit));

/**
 * The rows an explicit `released` disposition named, each at most once. A demo
 * tile or a not-yet-synced row is included so its reminders are still
 * cancelled; the executor is what withholds the DELETE from an id no server row
 * answers to.
 *
 * The de-duplication is not tidiness. A caller-supplied plan naming the same id
 * twice would issue two DELETEs; the second finds the row already gone and
 * rejects, and the executor reads that rejection as "this habit did not go" and
 * puts back a row the first call successfully deleted — store and server left
 * further apart by the retry than by any failure.
 */
const releasedRows = (plan: HabitMergePlan, byId: ReadonlyMap<number, Habit>): Habit[] => {
  const rows: Habit[] = [];
  const seen = new Set<number>();
  for (const disposition of plan) {
    if (disposition.kind !== 'released' || seen.has(disposition.habitId)) continue;
    seen.add(disposition.habitId);
    const row = byId.get(disposition.habitId);
    if (row !== undefined) rows.push(row);
  }
  return rows;
};

/**
 * Whether this row has anything to say to the server. Comparing the payloads
 * rather than the dispositions is what keeps a pass that changed nothing
 * silent: a retained row is only ever PUT when its position actually moved.
 */
const changedOnTheWire = (row: Habit, original: Habit | undefined): boolean =>
  original !== undefined &&
  isServerBackedHabit(row) &&
  JSON.stringify(toApiPayload(row)) !== JSON.stringify(toApiPayload(original));

/** The store the pass ends in, and the three phases of wire calls it implies. */
export interface HabitMergeOps {
  readonly nextStore: Habit[];
  /** Rows an explicit `released` disposition named, whether or not the server knows them. */
  readonly releases: Habit[];
  readonly updates: Habit[];
  readonly creates: Habit[];
}

/**
 * Turn a plan into the store it produces and the calls it owes.
 *
 * The phases are ordered by a constraint, not a preference: a released name is
 * free for reuse only once its DELETE has landed, because the server's unique
 * index does not care that the row is on its way out. Releasing "Meditate" and
 * creating a new "Meditate" in the same pass is exactly the case a create-first
 * order turns back into the swallowed 409 this whole change exists to remove.
 */
export const planHabitMerge = (plan: HabitMergePlan, existing: readonly Habit[]): HabitMergeOps => {
  const byId = new Map<number, Habit>();
  for (const habit of existing) if (!byId.has(habit.id)) byId.set(habit.id, habit);

  const minted = buildOnboardingHabits(
    plan.flatMap((disposition) => (disposition.kind === 'new' ? [disposition.habit] : [])),
    habitIdCeiling(existing),
    goalIdCeiling(existing),
  );
  const mintedIds = new Set(minted.map((row) => row.id));

  const nextStore = stampSortOrder([
    ...carriedRows(plan, byId, minted),
    ...unmentionedRows(existing, namedHabitIds(plan)),
  ]);

  return {
    nextStore,
    releases: releasedRows(plan, byId),
    updates: nextStore.filter(
      (row) => !mintedIds.has(row.id) && changedOnTheWire(row, byId.get(row.id)),
    ),
    creates: nextStore.filter((row) => mintedIds.has(row.id)),
  };
};
