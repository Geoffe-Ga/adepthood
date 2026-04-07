import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

import { habits as habitsApi, goalCompletions as goalCompletionsApi } from '../../../api';
import type { HabitCreatePayload } from '../../../api';
import type { ToastConfig } from '../../../components/Toast';
import { useToast } from '../../../components/ToastProvider';
import { colors } from '../../../design/tokens';
import {
  saveHabits as persistHabits,
  loadHabits as loadCachedHabits,
} from '../../../storage/habitStorage';
import { useHabitStore } from '../../../store/useHabitStore';
import { HABIT_DEFAULTS } from '../HabitDefaults';
import type { Goal, Habit, HabitScreenMode, OnboardingHabit } from '../Habits.types';
import { getGoalTier, getGoalTarget, calculateHabitProgress, logHabitUnits } from '../HabitUtils';

import {
  registerForPushNotificationsAsync,
  updateHabitNotifications,
  reconcileNotifications,
  cancelForHabit,
} from './useHabitNotifications';

const FALLBACK_HABITS: Habit[] = HABIT_DEFAULTS.map((habit) => ({
  ...habit,
  revealed: true,
  completions: [],
}));

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
    stage: '',
    name: h.name,
    icon: h.icon,
    streak: 0,
    energy_cost: h.energy_cost,
    energy_return: h.energy_return,
    start_date: new Date(h.start_date),
    goals: [],
    completions: [],
    revealed: true,
    notificationTimes: h.notification_times ?? undefined,
    notificationFrequency:
      (h.notification_frequency as Habit['notificationFrequency']) ?? undefined,
    notificationDays: h.notification_days ?? undefined,
    milestoneNotifications: h.milestone_notifications,
  }));

export interface UseHabitsReturn {
  habits: Habit[];
  loading: boolean;
  error: string | null;
  selectedHabit: Habit | null;
  setSelectedHabit: (_habit: Habit | null) => void;
  mode: HabitScreenMode;
  setMode: (_mode: HabitScreenMode) => void;
  actions: {
    loadHabits: () => Promise<void>;
    updateGoal: (_habitId: number, _updatedGoal: Goal) => void;
    logUnit: (_habitId: number, _amount: number) => void;
    updateHabit: (_updatedHabit: Habit) => void;
    deleteHabit: (_habitId: number) => void;
    saveHabitOrder: (_orderedHabits: Habit[]) => void;
    backfillMissedDays: (_habitId: number, _days: Date[]) => void;
    setNewStartDate: (_habitId: number, _newDate: Date) => void;
    onboardingSave: (_newHabits: OnboardingHabit[]) => Promise<void>;
    iconPress: (_index: number) => void;
    emojiSelect: (_emoji: string) => void;
    revealAllHabits: () => void;
    lockUnstartedHabits: () => void;
    unlockHabit: (_habitId: number) => void;
  };
  ui: {
    showEnergyCTA: boolean;
    showArchiveMessage: boolean;
    archiveEnergyCTA: () => void;
    emojiHabitIndex: number | null;
  };
  /** Exposed only for testing — do not use in production code. */
  setHabitsForTesting: (_habits: Habit[]) => void;
}

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

/** Milestone icon per goal tier. */
const MILESTONE_ICONS: Record<string, string> = {
  low: '\u{1F3C5}',
  clear: '\u{1F3AF}',
  stretch: '\u{1F31F}',
};

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

const syncGoalCompletion = (
  habit: Habit | undefined | null,
  previousHabits: Habit[],
  setHabits: (_h: Habit[]) => void,
) => {
  if (!habit || habit.goals.length === 0) return;
  const { currentGoal } = getGoalTier(habit);
  if (!currentGoal.id) return;
  goalCompletionsApi.create({ goal_id: currentGoal.id, did_complete: true }).catch(() => {
    setHabits(previousHabits);
    Alert.alert('Error', 'Failed to save progress. Please try again.');
  });
};

const syncHabitUpdate = (
  updatedHabit: Habit,
  previousHabits: Habit[],
  setHabits: (_h: Habit[]) => void,
) => {
  if (!updatedHabit.id) return;
  habitsApi.update(updatedHabit.id, toApiPayload(updatedHabit)).catch(() => {
    setHabits(previousHabits);
    Alert.alert('Error', 'Failed to update habit. Please try again.');
  });
};

const syncHabitDelete = (
  habitId: number,
  previousHabits: Habit[],
  setHabits: (_h: Habit[]) => void,
) => {
  habitsApi.delete(habitId).catch(() => {
    setHabits(previousHabits);
    Alert.alert('Error', 'Failed to delete habit. Please try again.');
  });
};

const handleApiSuccess = (
  apiHabits: Awaited<ReturnType<typeof habitsApi.list>>,
  hasCachedData: boolean,
  setHabits: (_h: Habit[]) => void,
) => {
  if (apiHabits.length === 0 && !hasCachedData) {
    setHabits(FALLBACK_HABITS);
    return;
  }
  if (apiHabits.length > 0) {
    const mapped = mapApiHabits(apiHabits);
    setHabits(mapped);
    void persistHabits(mapped);
  }
};

const handleApiError = (
  err: unknown,
  hasCachedData: boolean,
  setHabits: (_h: Habit[]) => void,
  setError: (_e: string | null) => void,
) => {
  console.error('Failed to load habits:', err);
  if (!hasCachedData) {
    setError('Failed to load habits. Please try again.');
    setHabits(FALLBACK_HABITS);
  }
};

const applyGoalUpdate = (habits: Habit[], habitId: number, updatedGoal: Goal): Habit[] =>
  habits.map((h) => {
    if (h.id !== habitId) return h;
    const goals = h.goals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal));
    normalizeGoalTiers(goals, updatedGoal);
    return { ...h, goals };
  });

const applyLogUnit = (
  habit: Habit,
  amount: number,
): { updatedHabit: Habit; oldProgress: number; newProgress: number } => {
  const oldProgress = calculateHabitProgress(habit);
  const updatedHabit = logHabitUnits(habit, amount);
  const newProgress = calculateHabitProgress(updatedHabit);
  return { updatedHabit, oldProgress, newProgress };
};

const useHabitLoader = () => {
  const storeSetHabits = useHabitStore((s) => s.setHabits);
  const storeSetLoading = useHabitStore((s) => s.setLoading);
  const storeSetError = useHabitStore((s) => s.setError);

  const fetchFromApi = useCallback(
    async (hasCachedData: boolean) => {
      try {
        const apiHabits = await habitsApi.list();
        handleApiSuccess(apiHabits, hasCachedData, storeSetHabits);
        storeSetError(null);
      } catch (err) {
        handleApiError(err, hasCachedData, storeSetHabits, storeSetError);
      }
    },
    [storeSetHabits, storeSetError],
  );

  const loadHabits = useCallback(async () => {
    storeSetLoading(true);
    storeSetError(null);
    const cached = await loadCachedHabits();
    const hasCachedData = cached !== null && cached.length > 0;
    if (hasCachedData) {
      storeSetHabits(cached);
      storeSetLoading(false);
    }
    await fetchFromApi(hasCachedData);
    storeSetLoading(false);
  }, [fetchFromApi, storeSetHabits, storeSetLoading, storeSetError]);

  useEffect(() => {
    void loadHabits();
  }, [loadHabits]);
  useEffect(() => {
    void registerForPushNotificationsAsync();
    void reconcileNotifications();
  }, []);

  return loadHabits;
};

const useHabitMutations = () => {
  const habits = useHabitStore((s) => s.habits);
  const storeSetHabits = useHabitStore((s) => s.setHabits);
  const updateGoal = useCallback(
    (habitId: number, updatedGoal: Goal) => {
      storeSetHabits(applyGoalUpdate(habits, habitId, updatedGoal));
    },
    [habits, storeSetHabits],
  );
  const updateHabit = useCallback(
    (updatedHabit: Habit) => {
      const prev = habits;
      const next = habits.map((h) => (h.id === updatedHabit.id ? updatedHabit : h));
      storeSetHabits(next);
      void updateHabitNotifications(updatedHabit);
      void persistHabits(next);
      syncHabitUpdate(updatedHabit, prev, storeSetHabits);
    },
    [habits, storeSetHabits],
  );
  const deleteHabit = useCallback(
    (habitId: number) => {
      const prev = habits;
      const next = habits.filter((h) => h.id !== habitId);
      storeSetHabits(next);
      void persistHabits(next);
      void cancelForHabit(habitId);
      syncHabitDelete(habitId, prev, storeSetHabits);
    },
    [habits, storeSetHabits],
  );
  const saveHabitOrder = useCallback(
    (ordered: Habit[]) => {
      storeSetHabits(ordered);
      void persistHabits(ordered);
    },
    [storeSetHabits],
  );
  return { habits, storeSetHabits, updateGoal, updateHabit, deleteHabit, saveHabitOrder };
};

const useHabitReveal = (habits: Habit[], storeSetHabits: (_h: Habit[]) => void) => {
  const revealAllHabits = useCallback(() => {
    const next = habits.map((h) => ({ ...h, revealed: true }));
    storeSetHabits(next);
    void persistHabits(next);
  }, [habits, storeSetHabits]);

  const lockUnstartedHabits = useCallback(() => {
    const now = Date.now();
    const next = habits.map((h) => ({
      ...h,
      revealed: new Date(h.start_date).getTime() <= now,
    }));
    storeSetHabits(next);
    void persistHabits(next);
  }, [habits, storeSetHabits]);

  const unlockHabit = useCallback(
    (habitId: number) => {
      const next = habits.map((h) => (h.id === habitId ? { ...h, revealed: true } : h));
      storeSetHabits(next);
      void persistHabits(next);
    },
    [habits, storeSetHabits],
  );

  return { revealAllHabits, lockUnstartedHabits, unlockHabit };
};

const INSTRUCTIONAL_TOAST_DURATION_MS = 5000;

const useHabitCrud = (showToast: (_config: ToastConfig) => void) => {
  const mutations = useHabitMutations();
  const { habits, storeSetHabits } = mutations;
  const backfillMissedDays = useCallback(
    (habitId: number, days: Date[]) => {
      storeSetHabits(habits.map((h) => (h.id === habitId ? backfillHabit(h, days) : h)));
    },
    [habits, storeSetHabits],
  );
  const setNewStartDate = useCallback(
    (habitId: number, newDate: Date) => {
      storeSetHabits(habits.map((h) => (h.id === habitId ? resetHabitStart(h, newDate) : h)));
    },
    [habits, storeSetHabits],
  );
  const onboardingSave = useCallback(
    async (newHabits: OnboardingHabit[]) => {
      const fullHabits = buildOnboardingHabits(newHabits);
      storeSetHabits(fullHabits);
      showToast({
        message: 'Tap a habit tile to edit its goals.',
        icon: '\u{1F449}',
        duration: INSTRUCTIONAL_TOAST_DURATION_MS,
      });
      await syncOnboardingHabits(fullHabits);
    },
    [storeSetHabits, showToast],
  );
  const reveal = useHabitReveal(habits, storeSetHabits);

  return { ...mutations, backfillMissedDays, setNewStartDate, onboardingSave, ...reveal };
};

const logAndToast = (
  habit: Habit,
  habitId: number,
  amount: number,
  showToast: (_config: ToastConfig) => void,
): Habit | null => {
  if (habit.id !== habitId) return null;
  const result = applyLogUnit(habit, amount);
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

const useHabitActions = (
  selectedHabit: Habit | null,
  setSelectedHabit: (_h: Habit | null) => void,
  showToast: (_config: ToastConfig) => void,
) => {
  const crud = useHabitCrud(showToast);
  const { habits, storeSetHabits } = crud;
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);

  const logUnit = useCallback(
    (habitId: number, amount: number) => {
      const previousHabits = habits;
      let updated: Habit | null = null;
      const newHabits = habits.map((h) => {
        const result = logAndToast(h, habitId, amount, showToast);
        if (!result) return h;
        updated = result;
        return result;
      });
      storeSetHabits(newHabits);
      if (selectedHabit?.id === habitId && updated) setSelectedHabit(updated);
      void persistHabits(newHabits);
      syncGoalCompletion(
        updated ?? habits.find((h) => h.id === habitId),
        previousHabits,
        storeSetHabits,
      );
    },
    [selectedHabit, habits, storeSetHabits, setSelectedHabit, showToast],
  );

  const iconPress = useCallback((index: number) => {
    setEmojiHabitIndex(index);
  }, []);

  const emojiSelect = useCallback(
    (emoji: string) => {
      if (emojiHabitIndex !== null)
        storeSetHabits(habits.map((h, i) => (i === emojiHabitIndex ? { ...h, icon: emoji } : h)));
      setEmojiHabitIndex(null);
    },
    [emojiHabitIndex, habits, storeSetHabits],
  );

  return { ...crud, logUnit, iconPress, emojiSelect, emojiHabitIndex };
};

const useHabitUI = () => {
  const [showEnergyCTA, setShowEnergyCTA] = useState(true);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);

  const archiveEnergyCTA = useCallback(() => {
    setShowEnergyCTA(false);
    setShowArchiveMessage(true);
    setTimeout(() => setShowArchiveMessage(false), 3000);
  }, []);

  return { showEnergyCTA, showArchiveMessage, archiveEnergyCTA };
};

export const useHabits = (): UseHabitsReturn => {
  const habits = useHabitStore((s) => s.habits);
  const loading = useHabitStore((s) => s.loading);
  const error = useHabitStore((s) => s.error);
  const storeSetHabits = useHabitStore((s) => s.setHabits);
  const { showToast } = useToast();
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null);
  const [mode, setMode] = useState<HabitScreenMode>('normal');

  const loadHabits = useHabitLoader();
  const actionsHook = useHabitActions(selectedHabit, setSelectedHabit, showToast);
  const ui = useHabitUI();

  return {
    habits,
    loading,
    error,
    selectedHabit,
    setSelectedHabit,
    mode,
    setMode,
    actions: {
      loadHabits,
      updateGoal: actionsHook.updateGoal,
      logUnit: actionsHook.logUnit,
      updateHabit: actionsHook.updateHabit,
      deleteHabit: actionsHook.deleteHabit,
      saveHabitOrder: actionsHook.saveHabitOrder,
      backfillMissedDays: actionsHook.backfillMissedDays,
      setNewStartDate: actionsHook.setNewStartDate,
      onboardingSave: actionsHook.onboardingSave,
      iconPress: actionsHook.iconPress,
      emojiSelect: actionsHook.emojiSelect,
      revealAllHabits: actionsHook.revealAllHabits,
      lockUnstartedHabits: actionsHook.lockUnstartedHabits,
      unlockHabit: actionsHook.unlockHabit,
    },
    ui: { ...ui, emojiHabitIndex: actionsHook.emojiHabitIndex },
    setHabitsForTesting: storeSetHabits,
  };
};
