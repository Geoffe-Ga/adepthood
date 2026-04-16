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

import { habits as habitsApi, goalCompletions as goalCompletionsApi } from '../../../api';
import type { HabitCreatePayload } from '../../../api';
import { formatApiError } from '../../../api/errorMessages';
import type { ToastConfig } from '../../../components/Toast';
import { colors } from '../../../design/tokens';
import {
  saveHabits as persistHabits,
  loadHabits as loadCachedHabits,
  savePendingCheckIn,
  loadPendingCheckIns,
  clearPendingCheckIns,
} from '../../../storage/habitStorage';
import { useHabitStore } from '../../../store/useHabitStore';
import { HABIT_DEFAULTS } from '../HabitDefaults';
import type { Goal, Habit, OnboardingHabit } from '../Habits.types';
import { getGoalTier, getGoalTarget, calculateHabitProgress, logHabitUnits } from '../HabitUtils';
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
});

const mapApiHabits = (apiHabits: Awaited<ReturnType<typeof habitsApi.list>>): Habit[] =>
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
    })),
    completions: [],
    revealed: true,
    notificationTimes: h.notification_times ?? undefined,
    notificationFrequency:
      (h.notification_frequency as Habit['notificationFrequency']) ?? undefined,
    notificationDays: h.notification_days ?? undefined,
    milestoneNotifications: h.milestone_notifications,
  }));

const normalizeGoalUnits = (goals: Goal[], updatedGoal: Goal): void => {
  const { target_unit: unit, frequency: freq, frequency_unit: freqUnit } = updatedGoal;
  for (const g of goals) {
    g.target_unit = unit;
    g.frequency = freq;
    g.frequency_unit = freqUnit;
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
): { updatedHabit: Habit; oldProgress: number; newProgress: number } => {
  const oldProgress = calculateHabitProgress(habit);
  const updatedHabit = logHabitUnits(habit, amount);
  const newProgress = calculateHabitProgress(updatedHabit);
  return { updatedHabit, oldProgress, newProgress };
};

const logAndToast = (
  habit: Habit,
  habitId: number,
  amount: number,
  showToast?: ShowToast,
): Habit | null => {
  if (habit.id !== habitId) return null;
  const result = applyLogUnit(habit, amount);
  if (!showToast) return result.updatedHabit;
  const { currentGoal, nextGoal } = getGoalTier(result.updatedHabit);
  const toast = buildMilestoneToast(
    habit.name,
    result.oldProgress,
    result.newProgress,
    currentGoal,
    nextGoal,
  );
  if (toast) showToast(toast);
  return result.updatedHabit;
};

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

// ---------------------------------------------------------------------------
// API sync helpers — every mutation optimistically updates the store and
// rolls back on network failure.
// ---------------------------------------------------------------------------

const handleApiSuccess = async (
  apiHabits: Awaited<ReturnType<typeof habitsApi.list>>,
  hasCachedData: boolean,
): Promise<void> => {
  if (apiHabits.length === 0 && !hasCachedData) {
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
  if (!hasCachedData) {
    setError(
      formatApiError(err, {
        fallback:
          "We couldn't load your habits. Check your connection, then pull down to try again.",
      }),
    );
    setHabits(FALLBACK_HABITS);
  }
};

const fetchFromApi = async (hasCachedData: boolean): Promise<void> => {
  try {
    const apiHabits = await habitsApi.list();
    await handleApiSuccess(apiHabits, hasCachedData);
    setError(null);
  } catch (err) {
    handleApiError(err, hasCachedData);
  }
};

/**
 * On write failure, roll the optimistic state back and explain to the user
 * what happened + what to do next. The fallback copy is intentionally
 * specific to the operation (e.g. "couldn't save that check-in") rather
 * than a generic "something went wrong" — users need to know whether to
 * retry or just refresh.
 */
const revertOnFailure = (prev: Habit[], fallback: string): ((err: unknown) => void) => {
  return (err: unknown) => {
    setHabits(prev);
    Alert.alert("Couldn't sync", formatApiError(err, { fallback }));
  };
};

// ---------------------------------------------------------------------------
// Public service: a plain object with async methods. Composable from hooks
// but not itself a hook. Every method is independently unit-testable.
// ---------------------------------------------------------------------------

export const habitManager = {
  loadHabits: async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const cached = await loadCachedHabits();
    const hasCachedData = cached !== null && cached.length > 0;
    if (hasCachedData) {
      setHabits(cached);
      setLoading(false);
    }
    await fetchFromApi(hasCachedData);
    setLoading(false);

    // BUG-HABITS-007: replay pending check-ins queued during offline
    const pending = await loadPendingCheckIns();
    if (pending.length > 0) {
      for (const checkIn of pending) {
        try {
          await goalCompletionsApi.create({
            goal_id: checkIn.goal_id,
            did_complete: checkIn.did_complete,
          });
        } catch {
          // still offline — leave in queue for next load
          return;
        }
      }
      await clearPendingCheckIns();
    }
  },

  updateGoal: (habitId: number, updatedGoal: Goal): void => {
    setHabits(applyGoalUpdate(getHabits(), habitId, updatedGoal));
  },

  updateHabit: (updatedHabit: Habit): void => {
    const prev = getHabits();
    const next = prev.map((h) => (h.id === updatedHabit.id ? updatedHabit : h));
    setHabits(next);
    void updateHabitNotifications(updatedHabit);
    void persistHabits(next);
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

  saveHabitOrder: (ordered: Habit[]): void => {
    setHabits(ordered);
    void persistHabits(ordered);
  },

  /**
   * Log `amount` units toward `habitId`, fire milestone toasts when a tier is
   * crossed, and sync to the backend. Returns the updated habit so UI code
   * can refresh a selected-habit copy if needed.
   */
  logUnit: (habitId: number, amount: number, showToast?: ShowToast): Habit | null => {
    const prev = getHabits();
    let updated: Habit | null = null;
    const next = prev.map((h) => {
      const result = logAndToast(h, habitId, amount, showToast);
      if (!result) return h;
      updated = result;
      return result;
    });
    setHabits(next);
    void persistHabits(next);

    const target = updated ?? prev.find((h) => h.id === habitId);
    if (target && target.goals.length > 0) {
      const { currentGoal } = getGoalTier(target);
      if (currentGoal.id) {
        const pendingPayload = { goal_id: currentGoal.id, did_complete: true };
        goalCompletionsApi.create(pendingPayload).catch((err: unknown) => {
          void savePendingCheckIn({
            ...pendingPayload,
            timestamp: new Date().toISOString(),
          });
          revertOnFailure(
            prev,
            "We couldn't save that check-in to the server. It's queued and will retry when you're back online.",
          )(err);
        });
      }
    }
    return updated;
  },

  backfillMissedDays: (habitId: number, days: Date[]): void => {
    setHabits(getHabits().map((h) => (h.id === habitId ? backfillHabit(h, days) : h)));
  },

  setNewStartDate: (habitId: number, newDate: Date): void => {
    setHabits(getHabits().map((h) => (h.id === habitId ? resetHabitStart(h, newDate) : h)));
  },

  onboardingSave: async (newHabits: OnboardingHabit[], showToast?: ShowToast): Promise<void> => {
    const fullHabits = buildOnboardingHabits(newHabits);
    setHabits(fullHabits as Habit[]);
    showToast?.({
      message: 'Tap a habit tile to edit its goals.',
      icon: '\u{1F449}',
      duration: INSTRUCTIONAL_TOAST_DURATION_MS,
    });
    await syncOnboardingHabits(fullHabits);
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

  setEmojiForHabit: (index: number, emoji: string): void => {
    setHabits(getHabits().map((h, i) => (i === index ? { ...h, icon: emoji } : h)));
  },
};

export type HabitManager = typeof habitManager;
