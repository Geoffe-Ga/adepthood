/**
 * Habit service layer — a plain object with async methods that mutate the
 * Zustand `useHabitStore`, persist to AsyncStorage, and sync with the backend.
 *
 * This module intentionally avoids React hooks so it can be unit-tested in
 * isolation. Consumers read state via `useHabitStore` selectors and call the
 * service methods below to trigger side effects.
 */

import { Alert } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

import {
  ApiError,
  ApiValidationError,
  habits as habitsApi,
  goalCompletions as goalCompletionsApi,
  goalGroups as goalGroupsApi,
  goals as goalsApi,
  toLocalHabit,
} from '../../../api';
import type { CheckInResult, GoalUnitsPayload, GoalUpdatePayload } from '../../../api';
import { formatApiError } from '../../../api/errorMessages';
import type { ToastConfig } from '../../../components/Toast';
import { colors } from '../../../design/tokens';
import {
  saveHabits as saveHabitsToDisk,
  loadHabits as loadCachedHabits,
  loadPendingCheckIns,
  clearDroppedCheckIns,
  clearPendingCheckIns,
  loadDroppedCheckIns,
  recordDroppedCheckIn,
  replacePendingCheckIns,
} from '../../../storage/habitStorage';
import type { DroppedCheckIn, PendingCheckIn } from '../../../storage/habitStorage';
import { useDroppedCheckInStore } from '../../../store/useDroppedCheckInStore';
import { useHabitStore } from '../../../store/useHabitStore';
import { useProgramStore } from '../../../store/useProgramStore';
import { dayKeyInTZ, detectDeviceTimezone, todayInUserTZ } from '../../../utils/dateUtils';
import { HABIT_DEFAULTS } from '../HabitDefaults';
import type { AddHabitInput, Goal, Habit, HabitMergePlan, OnboardingHabit } from '../Habits.types';
import {
  getGoalTier,
  getGoalTarget,
  calculateTodaysProgress,
  carryoverSlot,
  countCarryover,
  isNotCarryoverHabit,
  logHabitUnits,
  stageAtIndex,
} from '../HabitUtils';
import { updateHabitNotifications, cancelForHabit } from '../hooks/useHabitNotifications';

import type { HabitMergeOps } from './habitMerge';
import {
  buildTierGoals,
  deriveMergePlan,
  pickedHabits,
  planHabitMerge,
  toApiPayload,
} from './habitMerge';
import {
  ClientMintedIdError,
  isNotDemoSeed,
  isServerBackedGoal,
  isServerBackedHabit,
  isServerIssuedId,
} from './serverIds';

export type ShowToast = (_config: ToastConfig) => void;

// The offline/demo seed is shown only when the server is unreachable and no
// cache exists. Unlike server-seeded habits (locked by default), these demo
// tiles stay revealed so the offline experience is explorable rather than a
// wall of locked tiles.
const FALLBACK_HABITS: Habit[] = HABIT_DEFAULTS.map((habit) => ({
  ...habit,
  revealed: true,
  completions: [],
  // The sole construction site for the demo tiles, so this mark keeps their placeholder dates out of the program anchor however they are seeded.
  isDemoSeed: true,
}));

/**
 * The single write path to the habit cache. It always writes, even when the
 * filtered list is empty: an empty cache reads back as "no cache", which heals
 * a cache poisoned before this guard existed on the user's first mutation.
 */
const persistHabits = (habits: Habit[]): Promise<void> =>
  saveHabitsToDisk(habits.filter(isNotDemoSeed));

const INSTRUCTIONAL_TOAST_DURATION_MS = 5000;

/** The one title every write-failure alert carries; the fallback copy is what varies. */
const SYNC_FAILURE_TITLE = "Couldn't sync";

/** Milestone icon per goal tier. */
const MILESTONE_ICONS: Record<string, string> = {
  low: '\u{1F3C5}',
  clear: '\u{1F3AF}',
  stretch: '\u{1F31F}',
};

/** Generic check-mark used for the "logged, no milestone yet" confirmation. */
const LOG_CONFIRMATION_ICON = '\u{2705}';

// ---------------------------------------------------------------------------
// Pure helpers — safe to unit-test without React or the store.
// ---------------------------------------------------------------------------

// Delegate field mapping + tier/notification-frequency sanitizing to the
// canonical ``toLocalHabit`` boundary; ``sort_order`` is the one Habits-only
// field it does not carry, so preserve it via the spread override.
const mapApiHabits = (apiHabits: Awaited<ReturnType<typeof habitsApi.listAll>>): Habit[] =>
  apiHabits.map((h) => ({ ...toLocalHabit(h), sort_order: h.sort_order ?? null }));

// is_additive is propagated so single-tier flips can't leave the store half-additive (normalizeGoalTiers keys off low.is_additive).
const normalizeGoalUnits = (goals: Goal[], updatedGoal: Goal): void => {
  const {
    target_unit: unit,
    frequency: freq,
    frequency_unit: freqUnit,
    is_additive: additive,
  } = updatedGoal;
  for (const g of goals) {
    g.target_unit = unit;
    g.frequency = freq;
    g.frequency_unit = freqUnit;
    g.is_additive = additive;
  }
};

const clampAdditiveTargets = (low: Goal, clear: Goal, stretch: Goal): void => {
  if (low.target > clear.target) clear.target = low.target;
  if (clear.target > stretch.target) stretch.target = clear.target;
};

const clampSubtractiveTargets = (low: Goal, clear: Goal, stretch: Goal): void => {
  if (clear.target < stretch.target) clear.target = stretch.target;
  if (low.target < clear.target) low.target = clear.target;
};

const normalizeGoalTiers = (goals: Goal[], updatedGoal: Goal): void => {
  const low = goals.find((g) => g.tier === 'low');
  const clear = goals.find((g) => g.tier === 'clear');
  const stretch = goals.find((g) => g.tier === 'stretch');
  if (!low || !clear || !stretch) return;

  normalizeGoalUnits(goals, updatedGoal);
  if (low.is_additive) clampAdditiveTargets(low, clear, stretch);
  else clampSubtractiveTargets(low, clear, stretch);
};

export const applyGoalUpdate = (habits: Habit[], habitId: number, updatedGoal: Goal): Habit[] =>
  habits.map((h) => {
    if (h.id !== habitId) return h;
    // Copy every goal before normalizing — the caller's ``prev`` rollback
    // snapshot shares these object refs, so mutating in place would corrupt
    // the untouched tiers of the pre-edit state.
    const goals = h.goals.map((goal) => ({ ...(goal.id === updatedGoal.id ? updatedGoal : goal) }));
    normalizeGoalTiers(goals, updatedGoal);
    return { ...h, goals };
  });

const buildMilestoneToast = (
  habitName: string,
  oldProgress: number,
  newProgress: number,
  currentGoal: Goal,
  nextGoal: Goal | null,
): ToastConfig | null => {
  if (!currentGoal.is_additive) return null;

  const currentTarget = getGoalTarget(currentGoal);
  const justReached = oldProgress < currentTarget && newProgress >= currentTarget;
  if (!justReached) return null;

  if (currentGoal.tier === 'low') {
    return {
      message: `Low Goal achieved for ${habitName}! Keep going for the Clear Goal.`,
      icon: MILESTONE_ICONS.low,
      color: colors.tier.low,
    };
  } else if (currentGoal.tier === 'clear' && nextGoal) {
    return {
      message: 'Clear Goal achieved! Keep going for the Stretch Goal!',
      icon: MILESTONE_ICONS.clear,
      color: colors.tier.clear,
    };
  } else if (currentGoal.tier === 'stretch') {
    return {
      message: `Stretch Goal achieved for ${habitName}! Amazing!`,
      icon: MILESTONE_ICONS.stretch,
      color: colors.tier.stretch,
    };
  }
  return null;
};

/**
 * Generic "we recorded your log" toast. Surfaces when a unit log doesn't
 * cross a tier threshold so the user always gets explicit confirmation,
 * not just a few-pixel progress-bar redraw — closes the user-reported
 * "logging units is doing nothing" feedback gap on mobile.
 */
const buildLogConfirmationToast = (habitName: string, amount: number): ToastConfig => ({
  message: `Logged ${amount} for ${habitName}`,
  icon: LOG_CONFIRMATION_ICON,
  color: colors.success,
});

const backfillHabit = (habit: Habit, days: Date[]): Habit => {
  const newCompletions = days.map((day) => ({
    id: uuidv4(),
    timestamp: day,
    completed_units: 1,
  }));
  const updatedCompletions = habit.completions
    ? [...habit.completions, ...newCompletions]
    : newCompletions;
  return {
    ...habit,
    streak: habit.streak + days.length,
    last_completion_date: new Date(),
    completions: updatedCompletions,
  };
};

const resetHabitStart = (habit: Habit, newDate: Date): Habit => ({
  ...habit,
  start_date: newDate,
  streak: 0,
  last_completion_date: undefined,
  completions: [],
});

/**
 * Build a brand-new habit row from a minimal user input. Stage cycles through
 * STAGE_ORDER so habits added after the original ten still pick up an
 * aptitude color; the ids are placeholders replaced when the server round-trip
 * succeeds and `loadHabits` rehydrates from the API.
 *
 * `hasClientMintedIds` — not the negative sign — is what keeps those ids off
 * the wire; the timestamp-derived sign convention survives as belt-and-braces
 * and as a readable "this is not a real id" cue in a debugger.
 *
 * The new row's slot comes from its own partition of ``prev``: a program add
 * takes the next non-carryover index, while a carryover add takes the next
 * carryover index and colors from its negative display slot — so mixed lists
 * never inflate either side's slot with the other's count.
 */
const buildAddedHabit = (input: AddHabitInput, prev: Habit[], isCarryover: boolean): Habit => {
  const slotIndex = isCarryover ? countCarryover(prev) : prev.filter(isNotCarryoverHabit).length;
  const stage = stageAtIndex(isCarryover ? carryoverSlot(slotIndex) : slotIndex);
  const tempId = -Date.now();
  const name = input.name.trim();
  return {
    id: tempId,
    stage,
    name,
    icon: input.icon,
    streak: 0,
    energy_cost: input.energy_cost ?? 5,
    energy_return: input.energy_return ?? 5,
    start_date: new Date(),
    goals: buildTierGoals(name, (ti) => tempId - ti - 1),
    completions: [],
    revealed: false,
    hasClientMintedIds: true,
    // Partition-scoped ordinal, not a global one: carryover and program slots
    // each restart at 0, so read sort_order only after splitting by is_carryover.
    sort_order: slotIndex,
    ...(isCarryover ? { is_carryover: true } : {}),
  };
};

/**
 * The universal program anchor, derived from the habits the program actually
 * governs. It takes the min rather than index 0 in case the list is unsorted,
 * but the min is over an excluded set, which is why this is not named for the
 * minimum it computes: two whole categories of row carry a ``start_date`` that
 * is not a program date at all.
 *
 * Demo-seed tiles are excluded because their hard-coded placeholder dates would
 * otherwise anchor a day-one user's calendar years into the program. Carryover
 * habits are excluded because their date is when the user began that habit in
 * their own life, before the program; letting one win would move every screen's
 * stage and week back to a day the program had not started. A store holding
 * nothing but those two kinds yields no anchor at all, which is the correct
 * answer -- there is no program date in it to find.
 */
const deriveProgramAnchor = (
  habits: ReadonlyArray<{ start_date: Date; isDemoSeed?: boolean; is_carryover?: boolean }>,
): Date | null => {
  let earliest: number | null = null;
  for (const habit of habits.filter(isNotDemoSeed).filter(isNotCarryoverHabit)) {
    const time = new Date(habit.start_date).getTime();
    if (Number.isNaN(time)) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest === null ? null : new Date(earliest);
};

/**
 * Fill a MISSING universal program anchor by re-deriving it from the live
 * habits. Map, Practice, Course and Journal all read this anchor to compute the
 * current week/stage, and only ``loadHabits`` runs on every session, so without
 * this a returning user — whose persisted anchor was wiped on logout, or who
 * onboarded before the anchor existed — keeps a calendar-correct Habits screen
 * while every other screen falls back to a divergent server value.
 *
 * Three writers set this anchor, and they are not equal. Two are EXPLICIT and
 * authoritative, because each records a day the user chose: the scaffolding
 * date at ``onboardingSave``, and the reorder modal's date picker. This one is
 * DERIVED and subordinate, and it writes only when no anchor is stored at all.
 *
 * The ordering is not a tie-break, it is the direction of the data. Program
 * habit dates are laid out FROM the anchor by both explicit writers, so the
 * anchor is the input and those dates are its output. Deriving it back out of
 * them is a lossy inverse, worth doing only when the input is lost. When a
 * stored anchor and the rows disagree, it is therefore the ROWS that are wrong
 * — and a derived value that overwrote the stored one would silently discard a
 * date the user actually picked, durably, since it persists to disk.
 *
 * Demo FALLBACK seeds and carryover habits are filtered out inside
 * ``deriveProgramAnchor``, so a store holding only those yields no anchor and
 * nothing is written.
 *
 * This is the client's anchor only. The server keeps its own, stamped when the
 * progress row is created, and the two are not reconciled here: a user who
 * picks a future start date will have a client anchor on that date and a server
 * anchor on the day they first arrived. Reconciling them is a separate change.
 */
const syncProgramAnchorFromHabits = (): void => {
  if (useProgramStore.getState().programStartDate !== null) return;
  const anchor = deriveProgramAnchor(getHabits());
  if (anchor === null) return;
  useProgramStore.getState().setProgramStartDate(anchor);
};

const syncOnboardingHabits = async (fullHabits: readonly Habit[]): Promise<void> => {
  for (const habit of fullHabits) {
    try {
      await habitsApi.create(toApiPayload(habit));
    } catch {
      console.error(`Failed to save habit "${habit.name}" to server`);
    }
  }
};

/**
 * Let a habit go, everywhere it lives. The reminder cancellation runs for every
 * released row — the user asked for the tile to go — while the DELETE is
 * withheld from a row the server never issued ids for, because a demo tile's
 * fabricated id collides with a real habit's and the delete cascades that
 * habit's goals and completions irreversibly.
 */
const releaseOne = async (habit: Habit): Promise<void> => {
  // Fire-and-forget, exactly as ``deleteHabit`` does it: the reminder is device
  // state, and awaiting it here would let a local scheduling failure be read as
  // a failed release — putting back a habit the user let go of, or, for a row
  // with no server id at all, reporting a sync failure for something that was
  // never going to leave the device.
  void cancelForHabit(habit.id);
  if (!isServerBackedHabit(habit)) return;
  await habitsApi.delete(habit.id);
};

/**
 * Run the releases and report which rows are still there. The blanket
 * ``revertOnFailure`` restore is deliberately not used: by the time a release
 * can fail, later phases of the same pass may already have committed, and
 * restoring the whole pre-merge array would throw those away and leave the
 * store further from the server than the failure did. So the repair is scoped
 * to the row that did not go, and the trailing reload reconciles the rest.
 */
const releaseHabits = async (releases: readonly Habit[]): Promise<Habit[]> => {
  if (releases.length === 0) return [];
  const results = await Promise.allSettled(releases.map(releaseOne));
  const stillHere: Habit[] = [];
  let firstError: unknown = null;
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const habit = releases[index];
    if (habit !== undefined) stillHere.push(habit);
    firstError ??= result.reason;
  });
  if (stillHere.length > 0) {
    Alert.alert(
      SYNC_FAILURE_TITLE,
      formatApiError(firstError, {
        fallback:
          "We couldn't let go of every habit on the server. The ones that stayed are back in " +
          'your list — check your connection and try again.',
      }),
    );
  }
  return stillHere;
};

/** Per-row tolerance, matching the create loop: one bad row does not stop the pass. */
const pushHabitUpdates = async (updates: readonly Habit[]): Promise<void> => {
  for (const habit of updates) {
    try {
      await habitsApi.update(habit.id, toApiPayload(habit));
    } catch {
      console.error(`Failed to update habit "${habit.name}" on server`);
    }
  }
};

/**
 * Accept the modal's picks or a caller's own plan. A pick is a chip the user
 * tapped and carries a string key; a disposition names a `kind`. An empty list
 * is the same pass either way — every existing row is retained — so the
 * ambiguity at zero length has no consequence.
 */
const asMergePlan = (
  input: readonly OnboardingHabit[] | HabitMergePlan,
  existing: readonly Habit[],
): HabitMergePlan => {
  const [first] = input;
  if (first !== undefined && 'kind' in first) return input as HabitMergePlan;
  return deriveMergePlan(input as readonly OnboardingHabit[], existing);
};

/**
 * The three phases, in the one order that works. Each is awaited to completion
 * before the next begins, because a released name is only free for a create to
 * reuse once its DELETE has landed — the server's unique index on
 * ``lower(trim(name))`` does not know the row is on its way out, and a
 * create-first order turns the reuse back into the swallowed 409 the merge
 * exists to remove.
 */
const commitHabitMerge = async (ops: HabitMergeOps): Promise<Habit[]> => {
  const stillHere = await releaseHabits(ops.releases);
  await pushHabitUpdates(ops.updates);
  await syncOnboardingHabits(ops.creates);
  return stillHere;
};

const applyLogUnit = (
  habit: Habit,
  amount: number,
  tz: string,
  date?: Date,
): { updatedHabit: Habit; oldProgress: number; newProgress: number } => {
  // Today-only progress so milestone toasts fire when the user crosses a
  // tier *today*, not based on yesterday's all-time total. The caller
  // forwards the user's IANA zone so the bucket boundary matches the tile.
  // ``date`` backfills a missed day; a past-day log leaves today's
  // progress untouched so no milestone celebration fires for it.
  const oldProgress = calculateTodaysProgress(habit, tz);
  const updatedHabit = logHabitUnits(habit, amount, date);
  const newProgress = calculateTodaysProgress(updatedHabit, tz);
  return { updatedHabit, oldProgress, newProgress };
};

/**
 * Closed-over snapshot for one logUnit operation. Capturing `prev` and
 * `next` here (rather than re-reading the store inside `rollback`) is
 * what lets BUG-FE-HABIT-001 stay closed under concurrent mutations: if
 * a second log lands while the first is in flight, each mutate has its
 * own context and rolls back to the right baseline.
 */
export interface LogUnitContext {
  prev: Habit[];
  next: Habit[];
  habitName: string;
  /** Amount of units the caller logged in this operation. */
  amount: number;
  oldProgress: number;
  newProgress: number;
  currentGoal: Goal;
  nextGoal: Goal | null;
  /**
   * ``YYYY-MM-DD`` day to backfill, sent to the API as ``completed_on``.
   * ``undefined`` when the log is for today — the server then defaults
   * the completion to the current wall-clock time.
   */
  completedOn?: string;
  /** Demo-seed tile: its goal id is client-fabricated, so a queued check-in could never post. */
  isDemoSeed?: boolean;
  /** The current goal's id when the server issued it; null when this device minted it. */
  serverGoalId: number | null;
}

// ---------------------------------------------------------------------------
// Store bindings — tiny adapters so service methods read/write the store
// without forcing consumers to thread it through. `useHabitStore.getState()`
// gives us plain-object access suitable for testing with mocks.
// ---------------------------------------------------------------------------

const setHabits = (habits: Habit[]): void => {
  useHabitStore.getState().setHabits(habits);
};

const setLoading = (loading: boolean): void => {
  useHabitStore.getState().setLoading(loading);
};

const setError = (error: string | null): void => {
  useHabitStore.getState().setError(error);
};

const getHabits = (): Habit[] => useHabitStore.getState().habits;

/**
 * Per-habit promise mutex for notification rescheduling (BUG-FE-HABIT-005).
 *
 * Two rapid ``updateHabit`` calls on the same habit used to interleave:
 * the second would read the pre-first-edit ``notificationIds`` (still in
 * the store because the first call had not yet flushed its return value)
 * and double-schedule on the device.  Chaining each habit's reschedule
 * onto the prior one and then writing the returned ids back into the
 * store before persisting closes both halves of the race.
 */
const rescheduleQueue: Map<number, Promise<void>> = new Map();

const rescheduleAndPersist = (habit: Habit): Promise<void> => {
  if (!habit.id) return Promise.resolve();
  const habitId = habit.id;
  const prior = rescheduleQueue.get(habitId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      const live = getHabits().find((h) => h.id === habitId);
      const target: Habit = live ?? habit;
      const ids = await updateHabitNotifications(target);
      const refreshed: Habit = { ...target, notificationIds: ids };
      setHabits(getHabits().map((h) => (h.id === habitId ? refreshed : h)));
      await persistHabits(getHabits());
    });
  rescheduleQueue.set(habitId, next);
  return next;
};

// ---------------------------------------------------------------------------
// API sync helpers — every mutation optimistically updates the store and
// rolls back on network failure.
// ---------------------------------------------------------------------------

const handleApiSuccess = async (
  apiHabits: Awaited<ReturnType<typeof habitsApi.listAll>>,
  hasCachedData: boolean,
): Promise<void> => {
  // Only seed FALLBACK when the user is truly fresh: no cache, no live store, no API.
  if (apiHabits.length === 0 && !hasCachedData && getHabits().length === 0) {
    setHabits(FALLBACK_HABITS);
    return;
  }
  if (apiHabits.length > 0) {
    const mapped = mapApiHabits(apiHabits);
    setHabits(mapped);
    await persistHabits(mapped);
  }
};

const handleApiError = (err: unknown, hasCachedData: boolean): void => {
  console.error('Failed to load habits:', err);
  // Mirrors the live-store guard in ``handleApiSuccess`` for the error path.
  if (hasCachedData || getHabits().length > 0) return;
  setError(
    formatApiError(err, {
      fallback: "We couldn't load your habits. Check your connection, then pull down to try again.",
    }),
  );
  setHabits(FALLBACK_HABITS);
};

type FetchResult = { kind: 'ok'; count: number } | { kind: 'error' };

const fetchFromApi = async (hasCachedData: boolean): Promise<FetchResult> => {
  try {
    const apiHabits = await habitsApi.listAll();
    await handleApiSuccess(apiHabits, hasCachedData);
    setError(null);
    return { kind: 'ok', count: apiHabits.length };
  } catch (err) {
    handleApiError(err, hasCachedData);
    return { kind: 'error' };
  }
};

/** Re-push cached habits when the server has none — the caller re-fetches. */
const recoverStuckHabits = async (cached: Habit[]): Promise<void> => {
  for (const habit of cached) {
    try {
      // ``POST /habits/`` seeds default goal targets; the caller re-fetches
      // and then replays cached customizations via
      // ``replayCachedGoalTargets`` (#286).
      await habitsApi.create(toApiPayload(habit));
    } catch (err) {
      // Best-effort; partial recovery is still better than the stuck state.
      // Surface to console so Sentry / CI can flag chronic recovery failures.
      console.warn('recoverStuckHabits: failed to re-push', habit.name, err);
    }
  }
};

/** Order-sensitive equality with null/undefined/empty treated as "every day". */
const sameDaysOfWeek = (a: string[] | undefined, b: string[] | undefined): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((day, i) => day === right[i]);
};

/**
 * The cached group association, kept only if that group still exists
 * server-side — recovery may have outlived the groups the id pointed at,
 * and PUTting a dead id would fail the whole goal replay.
 */
const sanitizedGroupId = (cached: Goal, validGroupIds: Set<number>): number | null =>
  cached.goal_group_id != null && validGroupIds.has(cached.goal_group_id)
    ? cached.goal_group_id
    : null;

/** Server-side goal-group ids, for validating cached associations. */
const fetchServerGroupIds = async (): Promise<Set<number>> => {
  try {
    const groups = await goalGroupsApi.list();
    return new Set(groups.map((g) => g.id));
  } catch {
    // Best-effort: with no list, replay proceeds without associations.
    return new Set();
  }
};

/** True when the cached goal carries values the freshly-seeded one lacks. */
const goalNeedsReplay = (cached: Goal, fresh: Goal, validGroupIds: Set<number>): boolean =>
  cached.target !== fresh.target ||
  cached.target_unit !== fresh.target_unit ||
  cached.frequency !== fresh.frequency ||
  cached.frequency_unit !== fresh.frequency_unit ||
  cached.is_additive !== fresh.is_additive ||
  sanitizedGroupId(cached, validGroupIds) !== (fresh.goal_group_id ?? null) ||
  !sameDaysOfWeek(cached.days_of_week, fresh.days_of_week);

/** PUT one cached customization onto its freshly-seeded server goal. */
const replayOneGoal = async (
  cached: Goal,
  freshGoalId: number,
  title: string,
  validGroupIds: Set<number>,
): Promise<void> => {
  await goalsApi.update(freshGoalId, {
    title,
    tier: cached.tier,
    target: cached.target,
    target_unit: cached.target_unit,
    frequency: cached.frequency,
    frequency_unit: cached.frequency_unit,
    is_additive: cached.is_additive,
    // Full-replace PUT: omitting these would wipe surviving values.
    goal_group_id: sanitizedGroupId(cached, validGroupIds),
    days_of_week: cached.days_of_week ?? null,
  });
};

/** Copy cached values onto each fresh goal whose tier the server accepted. */
const mergeReplayedGoals = (
  habit: Habit,
  cachedHabit: Habit,
  replayedTiers: Set<string>,
  validGroupIds: Set<number>,
): Habit => ({
  ...habit,
  goals: habit.goals.map((fg) => {
    if (!replayedTiers.has(fg.tier)) return fg;
    const cg = cachedHabit.goals.find((g) => g.tier === fg.tier);
    if (!cg) return fg;
    return {
      ...fg,
      target: cg.target,
      target_unit: cg.target_unit,
      frequency: cg.frequency,
      frequency_unit: cg.frequency_unit,
      is_additive: cg.is_additive,
      // Mirror what the PUT actually sent, not the raw cached value.
      goal_group_id: sanitizedGroupId(cg, validGroupIds),
      days_of_week: cg.days_of_week,
    };
  }),
});

/** Replay one habit's customized goals; returns the tiers the server accepted. */
const replayHabitGoals = async (
  cachedHabit: Habit,
  freshHabit: Habit,
  validGroupIds: Set<number>,
): Promise<Set<string>> => {
  const replayedTiers = new Set<string>();
  for (const cachedGoal of cachedHabit.goals) {
    const freshGoal = freshHabit.goals.find((g) => g.tier === cachedGoal.tier);
    if (!freshGoal?.id || !goalNeedsReplay(cachedGoal, freshGoal, validGroupIds)) continue;
    try {
      await replayOneGoal(cachedGoal, freshGoal.id, freshGoal.title, validGroupIds);
      replayedTiers.add(cachedGoal.tier);
    } catch (err) {
      console.warn('replayCachedGoalTargets: failed for', cachedHabit.name, cachedGoal.tier, err);
    }
  }
  return replayedTiers;
};

/**
 * Replay cached goal customizations onto freshly-recovered habits (#286),
 * matched by (habit name, tier). Best-effort per goal; the store merges
 * only server-accepted tiers. Reads the immutable ``fresh`` snapshot —
 * deliberately NOT ``applyGoalUpdate``, whose in-place tier normalization
 * would cascade phantom replays. Goal-group associations replay only when
 * the group still exists server-side; days_of_week replays verbatim.
 */
const replayCachedGoalTargets = async (cached: Habit[], fresh: Habit[]): Promise<void> => {
  const validGroupIds = await fetchServerGroupIds();
  for (const cachedHabit of cached) {
    const freshHabit = fresh.find((h) => h.name === cachedHabit.name);
    if (!freshHabit?.id) continue;
    const replayedTiers = await replayHabitGoals(cachedHabit, freshHabit, validGroupIds);
    if (replayedTiers.size === 0) continue;
    const next = getHabits().map((h) =>
      h.id === freshHabit.id ? mergeReplayedGoals(h, cachedHabit, replayedTiers, validGroupIds) : h,
    );
    setHabits(next);
    void persistHabits(next);
  }
};

/**
 * On write failure, roll the optimistic state back and explain to the user
 * what happened + what to do next. The fallback copy is intentionally
 * specific to the operation (e.g. "couldn't save that check-in") rather
 * than a generic "something went wrong" — users need to know whether to
 * retry or just refresh.
 *
 * Restores BOTH the in-memory store AND the on-disk snapshot. The
 * mutation paths that call this helper (``updateHabit``, ``deleteHabit``,
 * ``updateGoal``, ``setEmojiForHabit``, ``saveHabitOrder``) all
 * optimistically ``persistHabits(next)`` before the API round-trip, so a
 * pure ``setHabits(prev)`` rollback would leave AsyncStorage holding the
 * failed write. A cold relaunch (process kill + reopen) would then
 * rehydrate from disk and silently diverge from the server — exactly
 * the cold-rehydrate failure mode this PR's emoji/order fixes set out
 * to close. Mirrors the pattern in ``rollbackLogUnitContext``.
 */
const revertOnFailure = (prev: Habit[], fallback: string): ((err: unknown) => void) => {
  return (err: unknown) => {
    setHabits(prev);
    void persistHabits(prev);
    Alert.alert(SYNC_FAILURE_TITLE, formatApiError(err, { fallback }));
  };
};

/**
 * Build a rejection handler that only alerts, leaving local state untouched.
 * Used when an earlier write already succeeded durably (e.g. the start-date
 * PUT) so a later step's failure must not roll the durable change back — it
 * only surfaces that the follow-up step did not complete.
 */
const warnOnFailure = (fallback: string): ((err: unknown) => void) => {
  return (err: unknown) => {
    Alert.alert(SYNC_FAILURE_TITLE, formatApiError(err, { fallback }));
  };
};

/**
 * Optimistically apply a new unlock (``revealed``) state and PUT each affected
 * row to the API. Shared by the bulk reveal/re-lock affordances and the
 * single-habit unlock so all three persist the flag server-side rather than
 * only in the store. Fans the PUTs out via ``Promise.all`` so a single
 * rejection triggers one deterministic rollback to ``prev`` (mirrors
 * ``saveHabitOrder``), restoring both the store and the on-disk snapshot.
 *
 * Demo tiles and pre-sync added habits flip in the store like any other row but
 * are never PUT: their ids are fabricated on-device, so there is no server row
 * for the write to land on.
 */
const syncRevealState = (next: Habit[], failureMessage: string): void => {
  const prev = getHabits();
  const revealedBefore = new Map(prev.map((h) => [h.id, h.revealed]));
  setHabits(next);
  void persistHabits(next);
  const updates: Array<Promise<unknown>> = [];
  for (const habit of next) {
    if (!isServerBackedHabit(habit)) continue;
    // Only PUT rows whose unlock flag actually flipped, so a single unlock
    // does not rewrite every untouched row.
    if (habit.revealed === revealedBefore.get(habit.id)) continue;
    updates.push(habitsApi.update(habit.id, toApiPayload(habit)));
  }
  if (updates.length === 0) return;
  Promise.all(updates).catch(revertOnFailure(prev, failureMessage));
};

/**
 * Statuses that mean this queued check-in will never post, however many
 * times we try it. Deliberately a closed allowlist: an unrecognised status
 * falls through to "transient", because mis-reading a transient failure as
 * permanent destroys a check-in the user actually made, while the reverse
 * only costs one retry.
 *
 * NOT the complement of ``TRANSIENT_STATUSES`` in ``api/index.ts``, and the
 * two must not be unified. That set governs an in-flight retry milliseconds
 * apart, where re-sending an expired token is pointless, so it excludes 401.
 * This queue spans app launches and ``AuthContext`` re-hydrates the token at
 * launch, so a 401 here means "not signed in right now", never "this
 * check-in is invalid" — dropping on it would wipe the queue of exactly the
 * user who has one.
 */
const PERMANENT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 422]);

/** Whether a replay failure is futile to retry, so the entry is dropped. */
const isPermanentRejection = (err: unknown): err is ApiError | ApiValidationError => {
  // Checked before any status lookup: ApiValidationError does not extend
  // ApiError and carries the response's own status, which can be a 2xx. It is
  // raised only when a received body failed its Zod schema — a deterministic
  // client/server contract defect, so a retry receives the same shape and
  // fails identically, forever. Retrying is futile rather than harmful:
  // ``POST /goal_completions/`` is idempotent by natural key (a unique index
  // over goal, user, and local day, with the service short-circuiting to
  // ``already_logged_today``), so a replay cannot duplicate a completion.
  // Treating it as transient would re-queue the entry at the head and wedge
  // every genuine check-in behind it — the wedge this drop exists to prevent.
  if (err instanceof ApiValidationError) return true;
  return err instanceof ApiError && PERMANENT_REJECTION_STATUSES.has(err.status);
};

/** POST one queued check-in, bucketing its day into the user's zone. */
const postPendingCheckIn = async (
  checkIn: PendingCheckIn,
  zone: string,
  today: string,
): Promise<void> => {
  const dayKey = dayKeyInTZ(checkIn.timestamp, zone);
  await goalCompletionsApi.create({
    goal_id: checkIn.goal_id,
    did_complete: checkIn.did_complete,
    // An explicit backfill day (queued by a backdated offline log)
    // wins; otherwise derive it from the queue timestamp.
    completed_on: checkIn.completed_on ?? (dayKey !== today ? dayKey : undefined),
  });
};

/**
 * Record a dropped check-in twice over: a console warning so a chronic
 * rejection is diagnosable, and a durable on-device quarantine so the loss is
 * reportable to the user who made the check-in. ``loadHabits`` has already
 * overwritten their optimistic completion with the server's canonical state by
 * the time we get here, so without the quarantine the action vanishes with no
 * trace anyone will ever see.
 */
const warnDroppedCheckIn = async (
  checkIn: PendingCheckIn,
  err: ApiError | ApiValidationError,
): Promise<void> => {
  console.warn(
    'replayPendingCheckIns: dropping permanently rejected check-in for goal',
    checkIn.goal_id,
    'status',
    err.status,
  );
  const quarantined: DroppedCheckIn = {
    ...checkIn,
    status: err.status,
    dropped_at: new Date().toISOString(),
  };
  await recordDroppedCheckIn(quarantined);
};

/**
 * Publish the on-device quarantine to the store the notice subscribes to. Runs
 * on every replay exit, including the ones that dropped nothing: an entry
 * quarantined in a previous session must still surface at launch, and an empty
 * list is what retracts a notice the user has since dismissed.
 */
const hydrateDroppedCheckIns = async (): Promise<void> => {
  const entries = await loadDroppedCheckIns();
  useDroppedCheckInStore.getState().setEntries(entries);
};

/**
 * Replay pending check-ins captured by an earlier offline session. On
 * transient failure, the suffix that didn't post is rewritten back to
 * disk so we don't double-post on the next replay; a permanently rejected
 * entry is dropped so it cannot wedge the queue ahead of everything the
 * user logged behind it.
 *
 * Each queued timestamp is forwarded as ``completed_on`` (the user-local
 * calendar day) so a check-in queued offline on Monday lands on Monday's
 * streak bucket, not on the wall-clock day the device reconnects (#269,
 * BUG-FE-HABIT-205). Same-day replays omit the field so the server
 * stamps real wall-clock time — the online path's genuine-backfill rule.
 */
const drainPendingCheckIns = async (tz?: string): Promise<void> => {
  const pending = await loadPendingCheckIns();
  if (pending.length === 0) return;
  // Device zone is the stand-in until auth hydrates the stored zone.
  const zone = tz ?? detectDeviceTimezone();
  const today = todayInUserTZ(zone);
  for (let i = 0; i < pending.length; i += 1) {
    const checkIn = pending[i]!;
    try {
      await postPendingCheckIn(checkIn, zone, today);
    } catch (err) {
      if (isPermanentRejection(err)) {
        // Awaited, not fired and forgotten: a floating quarantine write can
        // outlive the drain and lose the record it exists to keep.
        await warnDroppedCheckIn(checkIn, err);
        continue;
      }
      // Still offline, or a failure worth retrying. Persist only the
      // unprocessed suffix so the next replay doesn't repost the prefix —
      // every index below ``i`` is terminal, posted or dropped. That was
      // the BUG-FE-HABIT-205 partial-success regression.
      await replacePendingCheckIns(pending.slice(i));
      return;
    }
  }
  await clearPendingCheckIns();
};

/**
 * Drain the queue, then publish whatever the quarantine holds. Hydration is
 * outside the drain so it happens on every exit the drain has — nothing
 * queued, a transient abort, or a full pass — because a check-in dropped in an
 * earlier session is only real to the user once the notice can read it.
 */
const replayPendingCheckIns = async (tz?: string): Promise<void> => {
  await drainPendingCheckIns(tz);
  await hydrateDroppedCheckIns();
};

/**
 * Build one goal-completion POST per backfilled day, bucketing each day into
 * the user's IANA zone. A day that resolves to "today" omits ``completed_on``
 * so the server stamps real wall-clock time — the same genuine-backfill rule
 * the online log path uses; any earlier day sends its ``YYYY-MM-DD`` key so
 * the completion lands on the calendar day the user actually missed, not on
 * the wall-clock day the request happened to fire. Extracted so the caller
 * stays a flat, low-complexity sequence of guarded steps.
 */
const postBackfillCompletions = (
  lowGoalId: number,
  days: Date[],
  zone: string,
): Array<Promise<unknown>> => {
  const today = todayInUserTZ(zone);
  return days.map((day) => {
    const dayKey = dayKeyInTZ(day, zone);
    const completedOn = dayKey !== today ? dayKey : undefined;
    return goalCompletionsApi.create({
      goal_id: lowGoalId,
      did_complete: true,
      completed_on: completedOn,
    });
  });
};

// ---------------------------------------------------------------------------
// Public service: a plain object with async methods. Composable from hooks
// but not itself a hook. Every method is independently unit-testable.
// ---------------------------------------------------------------------------

/**
 * Zone from the most recent tz-carrying ``loadHabits`` call. Internal
 * re-fetches (``addHabit``, ``onboardingSave``) call ``loadHabits()``
 * without a zone; remembering the hook-supplied value here keeps their
 * queued-check-in replays on the user's stored zone instead of silently
 * falling back to the device's (#414 review).
 */
let lastKnownTz: string | undefined;

const loadHabits = async (tz?: string): Promise<void> => {
  if (tz !== undefined) lastKnownTz = tz;
  const zone = tz ?? lastKnownTz;
  setLoading(true);
  setError(null);
  const cached = await loadCachedHabits();
  const hasCachedData = cached !== null && cached.length > 0;
  if (hasCachedData) {
    setHabits(cached!);
    setLoading(false);
  }
  const result = await fetchFromApi(hasCachedData);
  // Stuck-user recovery: cache has real habits, server returned an empty list.
  // Push those back, then re-fetch so the store gets the server's ids. Demo
  // tiles left in an older cache are skipped on both legs, so a cache holding
  // nothing else means the user was never stuck.
  const recoverable = (cached ?? []).filter(isNotDemoSeed);
  if (result.kind === 'ok' && result.count === 0 && recoverable.length > 0) {
    await recoverStuckHabits(recoverable);
    const refetch = await fetchFromApi(true);
    // #286: the recovery push seeded default goal targets — replay any
    // cached customizations onto the fresh server goals.
    if (refetch.kind === 'ok') {
      await replayCachedGoalTargets(recoverable, getHabits());
    }
  }
  setLoading(false);

  // Give Map/Practice/Course/Journal an anchor to read if none is stored yet,
  // by deriving one from the habits just loaded. A stored anchor is left alone:
  // it records a day the user chose, and this derivation does not outrank it.
  syncProgramAnchorFromHabits();

  // BUG-HABITS-007 + BUG-FE-HABIT-205 partial-success fix: replay pending
  // check-ins queued during offline, and when one fails mid-batch only re-
  // queue the suffix that didn't post. The previous implementation
  // ``return``-ed from the first failure with the successful prefix still
  // in the queue, so on the next load every check-in that had already
  // posted would post AGAIN — silent duplication of the user's streak.
  await replayPendingCheckIns(zone);
};

export const habitManager = {
  loadHabits,

  /**
   * Acknowledge the dropped-check-in notice: erase the on-device quarantine,
   * then retract the notice. Storage work lives here rather than in the store
   * so the store stays a dumb container the notice can subscribe to.
   *
   * The notice fires this and forgets it, so a rejected erase would surface as
   * an unhandled rejection. It is caught, and the notice is deliberately left
   * standing: the quarantine is still on disk, and retracting the report of a
   * loss whose record survived would claim a clearing that did not happen —
   * and the next hydration would republish it anyway.
   */
  dismissDroppedCheckIns: async (): Promise<void> => {
    try {
      await clearDroppedCheckIns();
    } catch (err: unknown) {
      console.warn('[habits] could not erase the dropped check-in quarantine', err);
      return;
    }
    useDroppedCheckInStore.getState().setEntries([]);
  },

  updateGoal: (habitId: number, updatedGoal: Goal): void => {
    const prev = getHabits();
    const parent = prev.find((h) => h.id === habitId);
    const next = applyGoalUpdate(prev, habitId, updatedGoal);
    setHabits(next);
    void persistHabits(next);
    // The optimistic write above keeps the UI responsive for every row. Only a
    // goal the server actually issued an id for goes on the wire. A Goal carries
    // no demo marker of its own, so ``isServerBackedGoal`` reads that half from
    // the parent habit. With a real id we PUT ``/goals/{id}`` and roll the store
    // back if the wire rejects the change — same pattern as ``updateHabit``.
    if (!isServerBackedGoal(updatedGoal, parent)) return;
    const payload: GoalUpdatePayload = {
      title: updatedGoal.title,
      tier: updatedGoal.tier,
      target: updatedGoal.target,
      target_unit: updatedGoal.target_unit,
      frequency: updatedGoal.frequency,
      frequency_unit: updatedGoal.frequency_unit,
      is_additive: updatedGoal.is_additive,
      goal_group_id: updatedGoal.goal_group_id ?? null,
      days_of_week: updatedGoal.days_of_week ?? null,
    };
    goalsApi
      .update(updatedGoal.id, payload)
      .catch(
        revertOnFailure(
          prev,
          "We couldn't save that goal change. Your local copy was restored — check your connection and try again.",
        ),
      );
  },

  /**
   * Atomically update the shared unit fields across every tier goal of a
   * habit: one optimistic apply, one batch PUT, one rollback closure — so a
   * partial failure can never split tiers between old and new units.
   */
  updateGoalUnits: (
    habitId: number,
    changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>,
  ): void => {
    const prev = getHabits();
    const habit = prev.find((h) => h.id === habitId);
    const reference = habit?.goals[0];
    if (!habit || !reference) return;
    const next = prev.map((h) =>
      h.id === habitId ? { ...h, goals: h.goals.map((g) => ({ ...g, ...changes })) } : h,
    );
    setHabits(next);
    void persistHabits(next);
    // Both halves are load-bearing and neither implies the other. The habit
    // check rejects demo tiles (positive but fabricated ids) and pre-sync added
    // habits (negative ids). The per-goal check additionally rejects a
    // server-backed habit whose tier goals have not been round-tripped yet: the
    // endpoint rewrites every tier of the habit at once, so an un-issued goal id
    // means the store's tiers are not the server's and the optimistic state we
    // just wrote would not be what the batch produced.
    if (!isServerBackedHabit(habit)) return;
    if (!habit.goals.every((g) => isServerIssuedId(g.id))) return;
    const payload: GoalUnitsPayload = {
      target_unit: changes.target_unit ?? reference.target_unit,
      frequency: changes.frequency ?? reference.frequency,
      frequency_unit: changes.frequency_unit ?? reference.frequency_unit,
    };
    habitsApi
      .updateGoalUnits(habitId, payload)
      .catch(
        revertOnFailure(
          prev,
          "We couldn't update those goal units on the server. Your changes were rolled back — check your connection and try again.",
        ),
      );
  },

  updateHabit: (updatedHabit: Habit): void => {
    const prev = getHabits();
    const next = prev.map((h) => (h.id === updatedHabit.id ? updatedHabit : h));
    setHabits(next);
    // Serialize per-habit notification rescheduling and write the freshly
    // returned ids back onto the habit before persisting, so a rapid second
    // edit reschedules against fresh ``notificationIds`` instead of double-scheduling.
    if (updatedHabit.id) void rescheduleAndPersist(updatedHabit);
    else void persistHabits(next);
    if (!isServerBackedHabit(updatedHabit)) return;
    habitsApi
      .update(updatedHabit.id, toApiPayload(updatedHabit))
      .catch(
        revertOnFailure(
          prev,
          "We couldn't save the changes to that habit. Your local copy was restored — check your connection and try again.",
        ),
      );
  },

  /**
   * Remove a habit everywhere it lives. The local removal, the on-disk write and
   * the reminder cancellation always run — the user asked for the tile to go.
   * Only the DELETE is conditional, and it is resolved from the row being
   * removed rather than from the raw id: a demo tile's fabricated id collides
   * with a real habit's, so an unguarded ``DELETE /habits/{id}`` would destroy
   * the user's own row of that number.
   */
  deleteHabit: (habitId: number): void => {
    const prev = getHabits();
    const target = prev.find((h) => h.id === habitId);
    const next = prev.filter((h) => h.id !== habitId);
    setHabits(next);
    void persistHabits(next);
    void cancelForHabit(habitId);
    if (!isServerBackedHabit(target)) return;
    habitsApi
      .delete(habitId)
      .catch(
        revertOnFailure(
          prev,
          "We couldn't delete that habit on the server. It's back in your list — check your connection and try again.",
        ),
      );
  },

  /**
   * Create a single habit outside the onboarding scaffolding flow. Optimistically
   * appends a placeholder row to the store so the user sees instant feedback,
   * then POSTs to ``/habits/`` and re-runs ``loadHabits`` so the temporary
   * negative ids are replaced with the server-assigned ones (otherwise the
   * goal-completion POSTs would 404 on the next log). ``isCarryover`` flags an
   * add made from a negative lap: the row keeps today's start date but slots
   * into the carryover partition instead of the program's.
   */
  addHabit: async (input: AddHabitInput, isCarryover = false): Promise<void> => {
    const prev = getHabits();
    const newHabit = buildAddedHabit(input, prev, isCarryover);
    const next = [...prev, newHabit];
    setHabits(next);
    void persistHabits(next);
    try {
      await habitsApi.create(toApiPayload(newHabit));
      await loadHabits();
    } catch (err) {
      revertOnFailure(
        prev,
        "We couldn't create that habit on the server. Check your connection and try again.",
      )(err);
    }
  },

  /**
   * Persist a user-chosen ordering. Stamps each habit with a positional
   * ``sort_order`` (the backend orders the list ascending by it) and PUTs
   * the rows so the order survives a logout — without the per-row PUT, the
   * reorder used to live only in AsyncStorage and was wiped on the next
   * cold rehydrate.
   *
   * Updates fan out via ``Promise.all`` so a single rejection triggers one
   * deterministic rollback rather than one per failure: the previous
   * implementation chained ``revertOnFailure`` on every PUT, so the second
   * (and third…) failure each restored ``prev``, clobbering successful
   * sibling writes that were already in the store.
   *
   * Demo tiles and pre-sync added habits keep their positions and are stamped
   * locally like any other row, but are never PUT: their ids are fabricated
   * on-device, so there is no server row for the write to land on.
   */
  saveHabitOrder: (ordered: Habit[]): void => {
    const prev = getHabits();
    const stamped = ordered.map((h, index) => ({ ...h, sort_order: index }));
    setHabits(stamped);
    void persistHabits(stamped);
    const updates: Array<Promise<unknown>> = [];
    for (const habit of stamped) {
      if (!isServerBackedHabit(habit)) continue;
      updates.push(habitsApi.update(habit.id, toApiPayload(habit)));
    }
    if (updates.length === 0) return;
    Promise.all(updates).catch(
      revertOnFailure(
        prev,
        "We couldn't save the new habit order. Your previous order was restored — check your connection and try again.",
      ),
    );
  },

  /**
   * Compute the next habit list for a logUnit operation without mutating
   * the store. Returns null when no habit matches `habitId`. The
   * resulting context is the input to `useOptimisticMutation` — `apply`
   * writes `next`, `commit` POSTs `serverGoalId`, and `rollback`
   * restores `prev`. `serverGoalId` is `currentGoal.id` only when the goal
   * is server-backed, and `null` otherwise, so a client-minted id never
   * reaches the wire: `commit` resyncs instead of posting.
   * Splitting the computation out of the side-effecting
   * apply step is what keeps the rollback closure correct: the snapshot
   * is captured by value before the optimistic write, so a later
   * concurrent mutate cannot clobber it.
   */
  prepareLogUnit: (
    habitId: number,
    amount: number,
    tz: string,
    date?: Date,
  ): LogUnitContext | null => {
    const prev = getHabits();
    let updated: Habit | null = null;
    let oldProgress = 0;
    let newProgress = 0;
    let habitName = '';
    let isDemoSeed = false;
    // The matched row is the only place the goal's provenance is recorded, so
    // keep a handle on it for the ``isServerBackedGoal`` check below.
    let parent: Habit | null = null;
    const next = prev.map((h) => {
      if (h.id !== habitId) return h;
      habitName = h.name;
      isDemoSeed = h.isDemoSeed === true;
      parent = h;
      const result = applyLogUnit(h, amount, tz, date);
      oldProgress = result.oldProgress;
      newProgress = result.newProgress;
      updated = result.updatedHabit;
      return result.updatedHabit;
    });
    if (!updated) return null;
    const { currentGoal, nextGoal } = getGoalTier(updated, tz);
    // Only send ``completed_on`` for a genuine backfill — a date that
    // resolves to today is left undefined so the server stamps the
    // completion with the real wall-clock time.
    const dayKey = date ? dayKeyInTZ(date, tz) : undefined;
    const completedOn = dayKey && dayKey !== todayInUserTZ(tz) ? dayKey : undefined;
    return {
      prev,
      next,
      habitName,
      amount,
      oldProgress,
      newProgress,
      currentGoal,
      nextGoal,
      completedOn,
      isDemoSeed,
      serverGoalId: isServerBackedGoal(currentGoal, parent) ? currentGoal.id : null,
    };
  },

  /**
   * Synchronous step of the logUnit optimistic mutation: write the
   * computed `next` list to the store and persist it to disk.
   */
  applyLogUnitContext: (ctx: LogUnitContext): void => {
    setHabits(ctx.next);
    void persistHabits(ctx.next);
  },

  /**
   * Network step. POSTs the goal completion. Returns null for a demo
   * placeholder, and rejects with `ClientMintedIdError` when this device minted
   * the goal id — the caller turns that into a resync.
   */
  commitLogUnitContext: async (ctx: LogUnitContext): Promise<CheckInResult | null> => {
    if (ctx.isDemoSeed === true) return null;
    // A non-server goal id used to be posted on purpose, to draw the 404
    // ``goal_not_found`` that triggers the stale-scaffold resync. That trade
    // cannot hold: an onboarding scaffold's goal id is a positive integer in
    // the server's own range, so the POST does not reliably 404 — when the id
    // happens to name a goal the caller owns, it SUCCEEDS and records a
    // completion against the wrong habit, celebration and all. The marker tells
    // us locally what the 404 told us remotely, so we resync without the
    // round-trip. The 404 path stays in the hook regardless: a row cached by a
    // build predating the marker, or a real server id whose goal was deleted
    // server-side, is visible only in the server's answer.
    if (ctx.serverGoalId === null) {
      throw new ClientMintedIdError(
        'This habit has not finished saving to your account, so its goal id names no server row.',
      );
    }
    return goalCompletionsApi.create({
      goal_id: ctx.serverGoalId,
      did_complete: true,
      completed_on: ctx.completedOn,
    });
  },

  /**
   * Failure step. Restores BOTH the store AND the on-disk snapshot —
   * before this fix `revertOnFailure` only touched the store, so the
   * next cold start would rehydrate the optimistic state and desync
   * from the server (BUG-FE-HABIT-001).
   */
  rollbackLogUnitContext: (ctx: LogUnitContext): void => {
    setHabits(ctx.prev);
    void persistHabits(ctx.prev);
  },

  /**
   * Build the toast for a successful log. Returns the milestone toast when
   * the user crosses a tier threshold, else a generic confirmation toast so
   * every successful log produces visible feedback. Called from `onSuccess`
   * — never from `apply` — so a server-rejected check-in does not flash any
   * celebration the user did not earn.
   */
  buildLogUnitToast: (ctx: LogUnitContext): ToastConfig => {
    const milestone = buildMilestoneToast(
      ctx.habitName,
      ctx.oldProgress,
      ctx.newProgress,
      ctx.currentGoal,
      ctx.nextGoal,
    );
    return milestone ?? buildLogConfirmationToast(ctx.habitName, ctx.amount);
  },

  /**
   * Backfill missed days: bump the local streak + completions, persist the
   * optimistic state, then POST one goal completion per day against the
   * habit's LOW-tier goal so the backfill survives the next ``loadHabits``
   * reload (which trusts the server as the source of truth). A single
   * ``Promise.all`` rejection rolls the store AND the on-disk snapshot back
   * to ``prev`` and alerts the user — the same deterministic single-rollback
   * pattern as ``saveHabitOrder``. When the habit is a demo tile, or it or its
   * low goal carries an id no server issued, we keep the optimistic update but
   * skip the network call: a pre-sync habit still shows the backfill locally,
   * and no fabricated id can trigger the rollback that would erase it.
   *
   * ``tz`` is the user's stored IANA zone forwarded by the hook; it falls
   * back to the last zone a ``loadHabits`` observed, then to the device zone.
   */
  backfillMissedDays: (habitId: number, days: Date[], tz?: string): void => {
    const prev = getHabits();
    const next = prev.map((h) => (h.id === habitId ? backfillHabit(h, days) : h));
    setHabits(next);
    void persistHabits(next);
    const parent = prev.find((h) => h.id === habitId);
    if (!isServerBackedHabit(parent)) return;
    const lowGoalId = parent.goals.find((g) => g.tier === 'low')?.id;
    if (!isServerIssuedId(lowGoalId)) return;
    const zone = tz ?? lastKnownTz ?? detectDeviceTimezone();
    const updates = postBackfillCompletions(lowGoalId, days, zone);
    Promise.all(updates).catch(
      revertOnFailure(
        prev,
        "We couldn't save those backfilled days. Your previous state was restored — check your connection and try again.",
      ),
    );
  },

  /**
   * Reset a habit's start date: clear the streak + completions locally,
   * persist, then run two server writes in sequence — first PUT the new start
   * date, and only once that resolves bulk-clear the habit's server-side
   * goal-completion rows via the clear-completions endpoint. Clearing
   * server-side means a later ``loadHabits`` refetch shows no stale
   * completions rather than rebuilding a streak from rows the reset was meant
   * to wipe. Without the PUT even the new start date would revert to the stale
   * server value. Sequencing matters because the clear is irreversible: if it
   * ran concurrently and the PUT failed, the rollback would restore the local
   * completions while the server had already dropped them, silently losing
   * history behind a "previous state was restored" message. Ordering the
   * reversible PUT first means a PUT failure never reaches the clear.
   *
   * The two stages fail differently and are handled separately. A PUT failure
   * changes nothing durably, so it fully rolls the store + on-disk snapshot
   * back to the previous state. A clear failure happens only after the PUT has
   * already persisted the new start date, so a full rollback would wrongly
   * revert that durable date; instead the optimistic reset is kept and the
   * user is told only the check-in clear failed, so retrying re-runs the
   * idempotent reset.
   */
  setNewStartDate: (habitId: number, newDate: Date): void => {
    const prev = getHabits();
    const next = prev.map((h) => (h.id === habitId ? resetHabitStart(h, newDate) : h));
    setHabits(next);
    void persistHabits(next);
    const updated = next.find((h) => h.id === habitId);
    // Suppresses the PUT *and* the chained clear: a demo tile's fabricated id
    // would point the irreversible clear-completions call at whichever real
    // habit of the user's happens to carry that number.
    if (!isServerBackedHabit(updated)) return;
    const updatedId = updated.id;
    habitsApi
      .update(updatedId, toApiPayload(updated))
      .then(
        () =>
          habitsApi
            .clearCompletions(updatedId)
            .catch(
              warnOnFailure(
                "Your new start date was saved, but we couldn't clear the old check-ins. Try the reset again.",
              ),
            ),
        revertOnFailure(
          prev,
          "We couldn't save the new start date. Your previous state was restored — check your connection and try again.",
        ),
      );
  },

  /**
   * Save a scaffolding pass over the habits the user already has.
   *
   * Takes either the modal's bare picks — the only thing the onboarding modal
   * can produce today, since it builds its list from scratch and never reads
   * the store — or a plan a caller derived itself, which is how a modal that
   * showed the user their current habits and asked would state a release.
   * Picks are read against the store here so the fix is reachable through the
   * screen that exists rather than waiting on the one that does not.
   */
  onboardingSave: async (
    input: readonly OnboardingHabit[] | HabitMergePlan,
    showToast?: ShowToast,
  ): Promise<void> => {
    const existing = getHabits();
    const plan = asMergePlan(input, existing);
    const ops = planHabitMerge(plan, existing);
    setHabits(ops.nextStore);
    // Anchor the universal course calendar to the first picked habit's start
    // date so the Map, Practice, Course, Journal and habit-unlock logic all
    // derive the same stage/week from one source. Without this a freshly-
    // onboarded user has a null anchor and every screen silently falls back to
    // divergent server/position values.
    //
    // Read from the picks, not from the merged store: the picks are the dates
    // the user just chose, while a kept row carries a date this pass did not
    // ask about — a carryover's is from before the program began at all.
    const anchor = deriveProgramAnchor(pickedHabits(plan));
    if (anchor) useProgramStore.getState().setProgramStartDate(anchor);
    showToast?.({
      message: 'Tap a habit tile to edit its goals.',
      icon: '\u{1F449}',
      duration: INSTRUCTIONAL_TOAST_DURATION_MS,
    });
    const stillHere = await commitHabitMerge(ops);
    if (stillHere.length > 0) setHabits([...getHabits(), ...stillHere]);
    // Persist BEFORE the reload, which is the only order that survives a pass
    // that released everything: ``loadHabits`` reads this cache back, and its
    // stuck-user recovery re-POSTs whatever it finds there when the server
    // returns an empty list — resurrecting, from a cache still holding the
    // pre-merge list, exactly the habits the user just let go of.
    await persistHabits(getHabits());
    // Round-trip server-assigned ids — synthetic goal ids would 404 on log.
    // If this GET fails, synthetic ids survive until the next launch — see #282.
    await loadHabits();
  },

  revealAllHabits: (): void => {
    const next = getHabits().map((h) => ({ ...h, revealed: true }));
    syncRevealState(
      next,
      "We couldn't unlock every habit. Your previous state was restored — check your connection and try again.",
    );
  },

  /**
   * Re-lock affordance: flips every UNTOUCHED habit (zero logged completions)
   * back to locked, leaving any habit the user has already logged against
   * unlocked. Re-locking is an allowed, declinable bulk action; it only hides
   * the tile — the underlying completions are preserved, so unlocking again
   * restores full history. Keys strictly off completions, never the calendar.
   */
  lockUntouchedHabits: (): void => {
    const next = getHabits().map((h) => ({
      ...h,
      revealed: (h.completions?.length ?? 0) > 0,
    }));
    syncRevealState(
      next,
      "We couldn't re-lock those habits. Your previous state was restored — check your connection and try again.",
    );
  },

  unlockHabit: (habitId: number): void => {
    const next = getHabits().map((h) => (h.id === habitId ? { ...h, revealed: true } : h));
    syncRevealState(
      next,
      "We couldn't unlock that habit. Your previous state was restored — check your connection and try again.",
    );
  },

  /**
   * Update a habit's icon and sync to the backend. Previously only mutated
   * the in-memory store, so the emoji was lost on the next ``GET /habits``
   * (logout, app restart, or even a stuck-user re-fetch). Persists locally
   * for instant rehydrate, then PUTs the row; on failure the rollback
   * restores both the store and the on-disk snapshot.
   */
  setEmojiForHabit: (index: number, emoji: string): void => {
    const prev = getHabits();
    const target = prev[index];
    if (!target) return;
    const updated: Habit = { ...target, icon: emoji };
    const next = prev.map((h, i) => (i === index ? updated : h));
    setHabits(next);
    void persistHabits(next);
    if (!isServerBackedHabit(updated)) return;
    habitsApi
      .update(updated.id, toApiPayload(updated))
      .catch(
        revertOnFailure(
          prev,
          "We couldn't save the new icon. Your previous icon was restored — check your connection and try again.",
        ),
      );
  },
};

export type HabitManager = typeof habitManager;
