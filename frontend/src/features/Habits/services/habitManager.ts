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
  habits as habitsApi,
  goalCompletions as goalCompletionsApi,
  goalGroups as goalGroupsApi,
  goals as goalsApi,
} from '../../../api';
import type {
  CheckInResult,
  GoalUnitsPayload,
  GoalUpdatePayload,
  HabitCreatePayload,
} from '../../../api';
import { formatApiError } from '../../../api/errorMessages';
import { flattenGoalCompletions } from '../../../api/flattenGoalCompletions';
import type { ToastConfig } from '../../../components/Toast';
import { colors, STAGE_ORDER } from '../../../design/tokens';
import {
  saveHabits as persistHabits,
  loadHabits as loadCachedHabits,
  loadPendingCheckIns,
  clearPendingCheckIns,
  replacePendingCheckIns,
} from '../../../storage/habitStorage';
import { useHabitStore } from '../../../store/useHabitStore';
import { useProgramStore } from '../../../store/useProgramStore';
import { dayKeyInTZ, detectDeviceTimezone, todayInUserTZ } from '../../../utils/dateUtils';
import { HABIT_DEFAULTS } from '../HabitDefaults';
import type { AddHabitInput, Goal, Habit, OnboardingHabit } from '../Habits.types';
import { getGoalTier, getGoalTarget, calculateTodaysProgress, logHabitUnits } from '../HabitUtils';
import { updateHabitNotifications, cancelForHabit } from '../hooks/useHabitNotifications';

export type ShowToast = (_config: ToastConfig) => void;

const FALLBACK_HABITS: Habit[] = HABIT_DEFAULTS.map((habit) => ({
  ...habit,
  revealed: true,
  completions: [],
}));

const INSTRUCTIONAL_TOAST_DURATION_MS = 5000;

/** Milestone icon per goal tier. */
const MILESTONE_ICONS: Record<string, string> = {
  low: '\u{1F3C5}',
  clear: '\u{1F3AF}',
  stretch: '\u{1F31F}',
};

/** Generic check-mark used for the "logged, no milestone yet" confirmation. */
const LOG_CONFIRMATION_ICON = '\u{2705}';

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

// ---------------------------------------------------------------------------
// Pure helpers — safe to unit-test without React or the store.
// ---------------------------------------------------------------------------

const toApiPayload = (h: Habit): HabitCreatePayload => ({
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
});

const mapApiHabits = (apiHabits: Awaited<ReturnType<typeof habitsApi.listAll>>): Habit[] =>
  apiHabits.map((h) => ({
    id: h.id,
    stage: h.stage ?? '',
    name: h.name,
    icon: h.icon,
    streak: h.streak ?? 0,
    energy_cost: h.energy_cost,
    energy_return: h.energy_return,
    start_date: new Date(h.start_date),
    goals: (h.goals ?? []).map((g) => ({
      id: g.id,
      title: g.title,
      tier: g.tier as 'low' | 'clear' | 'stretch',
      target: g.target,
      target_unit: g.target_unit,
      frequency: g.frequency,
      frequency_unit: g.frequency_unit,
      is_additive: g.is_additive,
      goal_group_id: g.goal_group_id ?? null,
      days_of_week: g.days_of_week ?? undefined,
    })),
    // Shared with ``toLocalHabit`` -- single-source dedupe + Date rehydration.
    completions: flattenGoalCompletions(h.goals ?? []),
    revealed: true,
    notificationTimes: h.notification_times ?? undefined,
    notificationFrequency:
      (h.notification_frequency as Habit['notificationFrequency']) ?? undefined,
    notificationDays: h.notification_days ?? undefined,
    milestoneNotifications: h.milestone_notifications,
    sort_order: h.sort_order ?? null,
  }));

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
    const goals = h.goals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal));
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

const buildOnboardingHabits = (newHabits: OnboardingHabit[]) =>
  newHabits.map((habit, index) => ({
    ...habit,
    id: index + 1,
    streak: 0,
    revealed: habit.stage === 'Beige',
    completions: [] as Habit['completions'],
    goals: GOAL_TIERS.map((t, ti) => ({
      id: index * 3 + ti + 1,
      title: `${t.label} goal for ${habit.name}`,
      ...DEFAULT_GOAL_CONFIG,
      tier: t.tier,
      target: t.target,
    })),
  }));

/**
 * Build a brand-new habit row from a minimal user input. Stage cycles through
 * STAGE_ORDER so habits added after the original ten still pick up an
 * aptitude color; ids are negative placeholders that get replaced when the
 * server round-trip succeeds and `loadHabits` rehydrates from the API.
 */
const buildAddedHabit = (input: AddHabitInput, existingCount: number): Habit => {
  const stage = STAGE_ORDER[existingCount % STAGE_ORDER.length] ?? 'Clear Light';
  const tempId = -Date.now();
  return {
    id: tempId,
    stage,
    name: input.name.trim(),
    icon: input.icon,
    streak: 0,
    energy_cost: input.energy_cost ?? 5,
    energy_return: input.energy_return ?? 5,
    start_date: new Date(),
    goals: GOAL_TIERS.map((t, ti) => ({
      id: tempId - ti - 1,
      title: `${t.label} goal for ${input.name.trim()}`,
      ...DEFAULT_GOAL_CONFIG,
      tier: t.tier,
      target: t.target,
    })),
    completions: [],
    revealed: true,
    sort_order: existingCount,
  };
};

/** Earliest habit start date (the program start); takes the min, not index 0, in case the list is unsorted. */
const earliestStartDate = (habits: ReadonlyArray<{ start_date: Date }>): Date | null => {
  let earliest: number | null = null;
  for (const habit of habits) {
    const time = new Date(habit.start_date).getTime();
    if (Number.isNaN(time)) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest === null ? null : new Date(earliest);
};

/** Same calendar day, ignoring time — the store normalises anchors to local midnight. */
const sameCalendarDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Re-derive the universal program anchor from the live habits' earliest
 * ``start_date``. Map, Practice, Course and Journal all read this anchor to
 * compute the current week/stage; it is written at ``onboardingSave`` but only
 * ``loadHabits`` runs on every session. Without this re-sync a returning user
 * — whose persisted anchor was wiped on logout, or who onboarded before the
 * anchor existed — keeps a calendar-correct Habits screen while every other
 * screen falls back to a divergent server value. Recomputing on load keeps all
 * screens in lockstep and self-heals a missing anchor. Skipped for the demo
 * FALLBACK seed, whose placeholder dates are not a real program start.
 */
const syncProgramAnchorFromHabits = (): void => {
  const anchor = earliestStartDate(getHabits());
  if (anchor === null) return;
  const current = useProgramStore.getState().programStartDate;
  if (current !== null && sameCalendarDay(current, anchor)) return;
  useProgramStore.getState().setProgramStartDate(anchor);
};

const syncOnboardingHabits = async (fullHabits: ReturnType<typeof buildOnboardingHabits>) => {
  for (const habit of fullHabits) {
    try {
      await habitsApi.create(toApiPayload(habit as Habit));
    } catch {
      console.error(`Failed to save habit "${habit.name}" to server`);
    }
  }
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
): Promise<boolean> => {
  // Only seed FALLBACK when the user is truly fresh: no cache, no live store, no API.
  if (apiHabits.length === 0 && !hasCachedData && getHabits().length === 0) {
    setHabits(FALLBACK_HABITS);
    return true;
  }
  if (apiHabits.length > 0) {
    const mapped = mapApiHabits(apiHabits);
    setHabits(mapped);
    await persistHabits(mapped);
  }
  return false;
};

const handleApiError = (err: unknown, hasCachedData: boolean): boolean => {
  console.error('Failed to load habits:', err);
  // Mirrors the live-store guard in ``handleApiSuccess`` for the error path.
  if (hasCachedData || getHabits().length > 0) return false;
  setError(
    formatApiError(err, {
      fallback: "We couldn't load your habits. Check your connection, then pull down to try again.",
    }),
  );
  setHabits(FALLBACK_HABITS);
  return true;
};

// ``seededFallback`` is true only when the store now holds the demo FALLBACK
// tiles — the caller skips the program-anchor sync so placeholder dates never
// become a real program start.
type FetchResult =
  | { kind: 'ok'; count: number; seededFallback: boolean }
  | { kind: 'error'; seededFallback: boolean };

const fetchFromApi = async (hasCachedData: boolean): Promise<FetchResult> => {
  try {
    const apiHabits = await habitsApi.listAll();
    const seededFallback = await handleApiSuccess(apiHabits, hasCachedData);
    setError(null);
    return { kind: 'ok', count: apiHabits.length, seededFallback };
  } catch (err) {
    const seededFallback = handleApiError(err, hasCachedData);
    return { kind: 'error', seededFallback };
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
    Alert.alert("Couldn't sync", formatApiError(err, { fallback }));
  };
};

/**
 * Replay pending check-ins captured by an earlier offline session. On
 * partial failure, the suffix that didn't post is rewritten back to
 * disk so we don't double-post on the next replay.
 *
 * Each queued timestamp is forwarded as ``completed_on`` (the user-local
 * calendar day) so a check-in queued offline on Monday lands on Monday's
 * streak bucket, not on the wall-clock day the device reconnects (#269,
 * BUG-FE-HABIT-205). Same-day replays omit the field so the server
 * stamps real wall-clock time — the online path's genuine-backfill rule.
 */
const replayPendingCheckIns = async (tz?: string): Promise<void> => {
  const pending = await loadPendingCheckIns();
  if (pending.length === 0) return;
  // Device zone is the stand-in until auth hydrates the stored zone.
  const zone = tz ?? detectDeviceTimezone();
  const today = todayInUserTZ(zone);
  for (let i = 0; i < pending.length; i += 1) {
    const checkIn = pending[i]!;
    const dayKey = dayKeyInTZ(checkIn.timestamp, zone);
    try {
      await goalCompletionsApi.create({
        goal_id: checkIn.goal_id,
        did_complete: checkIn.did_complete,
        // An explicit backfill day (queued by a backdated offline log)
        // wins; otherwise derive it from the queue timestamp.
        completed_on: checkIn.completed_on ?? (dayKey !== today ? dayKey : undefined),
      });
    } catch {
      // Still offline (or the server rejected this one). Persist only
      // the unprocessed suffix so the next replay doesn't repost the
      // successful prefix — that was the BUG-FE-HABIT-205 partial-
      // success regression.
      await replacePendingCheckIns(pending.slice(i));
      return;
    }
  }
  await clearPendingCheckIns();
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
  let seededFallback = result.seededFallback;
  // Stuck-user recovery: cache has habits, server returned an empty list.
  // Push the cache back, then re-fetch so the store gets the server's ids.
  if (result.kind === 'ok' && result.count === 0 && hasCachedData) {
    await recoverStuckHabits(cached!);
    const refetch = await fetchFromApi(true);
    seededFallback = refetch.seededFallback;
    // #286: the recovery push seeded default goal targets — replay any
    // cached customizations onto the fresh server goals.
    if (refetch.kind === 'ok') {
      await replayCachedGoalTargets(cached!, getHabits());
    }
  }
  setLoading(false);

  // Keep Map/Practice/Course/Journal aligned with the now-current habits by
  // re-deriving the shared program anchor from the real (non-demo) tiles.
  if (!seededFallback) syncProgramAnchorFromHabits();

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

  updateGoal: (habitId: number, updatedGoal: Goal): void => {
    const prev = getHabits();
    const next = applyGoalUpdate(prev, habitId, updatedGoal);
    setHabits(next);
    void persistHabits(next);
    // The optimistic write above + the local-only fallback for synthetic
    // ids (no ``id`` from the server) keep the UI responsive. With a real
    // id we POST to ``/goals/{id}`` and roll the store back if the wire
    // rejects the change — same pattern as ``updateHabit``.
    if (!updatedGoal.id) return;
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
   * habit (issue #289). One optimistic apply, one batch PUT, one rollback
   * closure — replaces the GoalUnitEditor's three-call fan-out whose
   * partial failure split tiers between old and new units server-side.
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
    // Synthetic ids (pre-sync onboarding state) stay local-only — the
    // same contract as ``updateGoal``.
    if (!habit.goals.every((g) => g.id)) return;
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
    // BUG-FE-HABIT-005: serialize per-habit notification rescheduling and
    // write the freshly-returned ids back onto the habit before
    // persisting.  The previous ``void updateHabitNotifications(...)``
    // discarded the return value, so a second rapid edit would still
    // see the pre-first-edit ``notificationIds`` and double-schedule.
    if (updatedHabit.id) void rescheduleAndPersist(updatedHabit);
    else void persistHabits(next);
    if (!updatedHabit.id) return;
    habitsApi
      .update(updatedHabit.id, toApiPayload(updatedHabit))
      .catch(
        revertOnFailure(
          prev,
          "We couldn't save the changes to that habit. Your local copy was restored — check your connection and try again.",
        ),
      );
  },

  deleteHabit: (habitId: number): void => {
    const prev = getHabits();
    const next = prev.filter((h) => h.id !== habitId);
    setHabits(next);
    void persistHabits(next);
    void cancelForHabit(habitId);
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
   * goal-completion POSTs would 404 on the next log).
   */
  addHabit: async (input: AddHabitInput): Promise<void> => {
    const prev = getHabits();
    const newHabit = buildAddedHabit(input, prev.length);
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
   */
  saveHabitOrder: (ordered: Habit[]): void => {
    const prev = getHabits();
    const stamped = ordered.map((h, index) => ({ ...h, sort_order: index }));
    setHabits(stamped);
    void persistHabits(stamped);
    const updates: Array<Promise<unknown>> = [];
    for (const habit of stamped) {
      if (habit.id == null) continue;
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
   * writes `next`, `commit` POSTs `currentGoal.id`, and `rollback`
   * restores `prev`. Splitting the computation out of the side-effecting
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
    const next = prev.map((h) => {
      if (h.id !== habitId) return h;
      habitName = h.name;
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
   * Network step. POSTs the goal completion. Returns null when the
   * habit has no current goal (rare; the store-side `prepareLogUnit`
   * has already validated `updated` exists, but we still guard here so
   * the API isn't hit with `goal_id: undefined`).
   */
  commitLogUnitContext: async (ctx: LogUnitContext): Promise<CheckInResult | null> => {
    if (!ctx.currentGoal.id) return null;
    return goalCompletionsApi.create({
      goal_id: ctx.currentGoal.id,
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

  backfillMissedDays: (habitId: number, days: Date[]): void => {
    // Persist like every sibling mutation — without this the backfill lives only
    // in the Zustand store and is silently lost on the next cold rehydrate (#783).
    const next = getHabits().map((h) => (h.id === habitId ? backfillHabit(h, days) : h));
    setHabits(next);
    void persistHabits(next);
  },

  setNewStartDate: (habitId: number, newDate: Date): void => {
    // Persist so the reset start date survives a rehydrate (#783).
    const next = getHabits().map((h) => (h.id === habitId ? resetHabitStart(h, newDate) : h));
    setHabits(next);
    void persistHabits(next);
  },

  onboardingSave: async (newHabits: OnboardingHabit[], showToast?: ShowToast): Promise<void> => {
    const fullHabits = buildOnboardingHabits(newHabits);
    setHabits(fullHabits as Habit[]);
    // Anchor the universal course calendar to the first habit's start date so
    // the Map, Practice, Course, Journal and habit-unlock logic all derive the
    // same stage/week from one source. Without this a freshly-onboarded user
    // has a null anchor and every screen silently falls back to divergent
    // server/position values.
    const anchor = earliestStartDate(newHabits);
    if (anchor) useProgramStore.getState().setProgramStartDate(anchor);
    showToast?.({
      message: 'Tap a habit tile to edit its goals.',
      icon: '\u{1F449}',
      duration: INSTRUCTIONAL_TOAST_DURATION_MS,
    });
    await syncOnboardingHabits(fullHabits);
    // Round-trip server-assigned ids — synthetic goal ids would 404 on log.
    // If this GET fails, synthetic ids survive until the next launch — see #282.
    await loadHabits();
  },

  revealAllHabits: (): void => {
    const next = getHabits().map((h) => ({ ...h, revealed: true }));
    setHabits(next);
    void persistHabits(next);
  },

  lockUnstartedHabits: (): void => {
    const now = Date.now();
    const next = getHabits().map((h) => ({
      ...h,
      revealed: new Date(h.start_date).getTime() <= now,
    }));
    setHabits(next);
    void persistHabits(next);
  },

  unlockHabit: (habitId: number): void => {
    const next = getHabits().map((h) => (h.id === habitId ? { ...h, revealed: true } : h));
    setHabits(next);
    void persistHabits(next);
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
    if (!updated.id) return;
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
