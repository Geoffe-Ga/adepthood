import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

import { habits as habitsApi, goalCompletions as goalCompletionsApi } from '../../../api';
import type { HabitCreatePayload } from '../../../api';
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

export const useHabits = (): UseHabitsReturn => {
  // Core state from Zustand store (shared across screens)
  const habits = useHabitStore((s) => s.habits);
  const loading = useHabitStore((s) => s.loading);
  const error = useHabitStore((s) => s.error);
  const storeSetHabits = useHabitStore((s) => s.setHabits);
  const storeSetLoading = useHabitStore((s) => s.setLoading);
  const storeSetError = useHabitStore((s) => s.setError);

  // Local UI state (screen-specific, not shared)
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null);
  const [mode, setMode] = useState<HabitScreenMode>('normal');
  const [showEnergyCTA, setShowEnergyCTA] = useState(true);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);

  const fetchFromApi = useCallback(
    async (hasCachedData: boolean) => {
      try {
        const apiHabits = await habitsApi.list();
        if (apiHabits.length === 0 && !hasCachedData) {
          storeSetHabits(FALLBACK_HABITS);
        } else if (apiHabits.length > 0) {
          const mapped = mapApiHabits(apiHabits);
          storeSetHabits(mapped);
          void persistHabits(mapped);
        }
        storeSetError(null);
      } catch (err) {
        console.error('Failed to load habits:', err);
        if (!hasCachedData) {
          storeSetError('Failed to load habits. Please try again.');
          storeSetHabits(FALLBACK_HABITS);
        }
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

  const updateGoal = useCallback(
    (habitId: number, updatedGoal: Goal) => {
      storeSetHabits(
        habits.map((h) => {
          if (h.id !== habitId) return h;
          const goals = h.goals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal));
          const low = goals.find((g) => g.tier === 'low');
          const clear = goals.find((g) => g.tier === 'clear');
          const stretch = goals.find((g) => g.tier === 'stretch');
          if (low && clear && stretch) {
            const unit = updatedGoal.target_unit;
            const freq = updatedGoal.frequency;
            const freqUnit = updatedGoal.frequency_unit;
            goals.forEach((g) => {
              g.target_unit = unit;
              g.frequency = freq;
              g.frequency_unit = freqUnit;
            });

            if (low.is_additive) {
              if (low.target > clear.target) clear.target = low.target;
              if (clear.target > stretch.target) stretch.target = clear.target;
            } else {
              if (clear.target < stretch.target) clear.target = stretch.target;
              if (low.target < clear.target) low.target = clear.target;
            }
          }
          return { ...h, goals };
        }),
      );
    },
    [habits, storeSetHabits],
  );

  const logUnit = useCallback(
    (habitId: number, amount: number) => {
      let updated: Habit | null = null;
      const previousHabits = habits;

      const newHabits = habits.map((h) => {
        if (h.id !== habitId) return h;
        const oldProgress = calculateHabitProgress(h);
        const updatedHabit = logHabitUnits(h, amount);
        const newProgress = calculateHabitProgress(updatedHabit);
        const { currentGoal, nextGoal } = getGoalTier(updatedHabit);
        updated = updatedHabit;

        if (currentGoal.is_additive) {
          const currentTarget = getGoalTarget(currentGoal);
          if (
            oldProgress < currentTarget &&
            newProgress >= currentTarget &&
            currentGoal.tier === 'low'
          ) {
            Alert.alert(
              'Goal Achieved!',
              `You've reached your Low Goal for ${h.name}! Keep going for the Clear Goal.`,
            );
          }
          if (
            nextGoal &&
            currentGoal.tier === 'clear' &&
            oldProgress < getGoalTarget(currentGoal) &&
            newProgress >= getGoalTarget(currentGoal)
          ) {
            Alert.alert('Achieved! Keep going for the Stretch Goal!');
          }
          if (
            nextGoal &&
            currentGoal.tier === 'stretch' &&
            oldProgress < getGoalTarget(currentGoal) &&
            newProgress >= getGoalTarget(currentGoal)
          ) {
            Alert.alert(
              'Stretch Goal Achieved!',
              `Amazing! You've reached your Stretch Goal for ${h.name}!`,
            );
          }
        }

        return updatedHabit;
      });

      storeSetHabits(newHabits);

      if (selectedHabit?.id === habitId && updated) {
        setSelectedHabit(updated);
      }

      void persistHabits(newHabits);

      const habit = updated ?? habits.find((h) => h.id === habitId);
      if (habit && habit.goals.length > 0) {
        const { currentGoal } = getGoalTier(habit);
        if (currentGoal.id) {
          goalCompletionsApi.create({ goal_id: currentGoal.id, did_complete: true }).catch(() => {
            storeSetHabits(previousHabits);
            Alert.alert('Error', 'Failed to save progress. Please try again.');
          });
        }
      }
    },
    [selectedHabit, habits, storeSetHabits],
  );

  const updateHabit = useCallback(
    (updatedHabit: Habit) => {
      const previousHabits = habits;
      const newHabits = habits.map((h) => (h.id === updatedHabit.id ? updatedHabit : h));
      storeSetHabits(newHabits);
      void updateHabitNotifications(updatedHabit);
      void persistHabits(newHabits);

      if (updatedHabit.id) {
        habitsApi.update(updatedHabit.id, toApiPayload(updatedHabit)).catch(() => {
          storeSetHabits(previousHabits);
          Alert.alert('Error', 'Failed to update habit. Please try again.');
        });
      }
    },
    [habits, storeSetHabits],
  );

  const deleteHabit = useCallback(
    (habitId: number) => {
      const previousHabits = habits;
      const newHabits = habits.filter((h) => h.id !== habitId);
      storeSetHabits(newHabits);
      void persistHabits(newHabits);
      void cancelForHabit(habitId);

      habitsApi.delete(habitId).catch(() => {
        storeSetHabits(previousHabits);
        Alert.alert('Error', 'Failed to delete habit. Please try again.');
      });
    },
    [habits, storeSetHabits],
  );

  const saveHabitOrder = useCallback(
    (orderedHabits: Habit[]) => {
      storeSetHabits(orderedHabits);
      void persistHabits(orderedHabits);
    },
    [storeSetHabits],
  );

  const backfillMissedDays = useCallback(
    (habitId: number, days: Date[]) => {
      storeSetHabits(
        habits.map((habit) => {
          if (habit.id === habitId) {
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
          }
          return habit;
        }),
      );
    },
    [habits, storeSetHabits],
  );

  const setNewStartDate = useCallback(
    (habitId: number, newDate: Date) => {
      storeSetHabits(
        habits.map((habit) => {
          if (habit.id === habitId) {
            return {
              ...habit,
              start_date: newDate,
              streak: 0,
              last_completion_date: undefined,
              completions: [],
            };
          }
          return habit;
        }),
      );
    },
    [habits, storeSetHabits],
  );

  const onboardingSave = useCallback(
    async (newHabits: OnboardingHabit[]) => {
      const fullHabits = newHabits.map((habit, index) => ({
        ...habit,
        id: index + 1,
        streak: 0,
        revealed: habit.stage === 'Beige',
        completions: [] as Habit['completions'],
        goals: [
          {
            id: index * 3 + 1,
            title: `Low goal for ${habit.name}`,
            tier: 'low' as const,
            target: 1,
            target_unit: 'units',
            frequency: 1,
            frequency_unit: 'per_day',
            is_additive: true,
          },
          {
            id: index * 3 + 2,
            title: `Clear goal for ${habit.name}`,
            tier: 'clear' as const,
            target: 2,
            target_unit: 'units',
            frequency: 1,
            frequency_unit: 'per_day',
            is_additive: true,
          },
          {
            id: index * 3 + 3,
            title: `Stretch goal for ${habit.name}`,
            tier: 'stretch' as const,
            target: 3,
            target_unit: 'units',
            frequency: 1,
            frequency_unit: 'per_day',
            is_additive: true,
          },
        ],
      }));

      storeSetHabits(fullHabits);
      Alert.alert('Next steps', 'Tap a habit tile to edit its goals.');

      for (const habit of fullHabits) {
        try {
          await habitsApi.create(toApiPayload(habit as Habit));
        } catch {
          console.error(`Failed to save habit "${habit.name}" to server`);
        }
      }
    },
    [storeSetHabits],
  );

  const iconPress = useCallback((index: number) => {
    setEmojiHabitIndex(index);
  }, []);

  const emojiSelect = useCallback(
    (emoji: string) => {
      if (emojiHabitIndex !== null) {
        storeSetHabits(habits.map((h, i) => (i === emojiHabitIndex ? { ...h, icon: emoji } : h)));
      }
      setEmojiHabitIndex(null);
    },
    [emojiHabitIndex, habits, storeSetHabits],
  );

  const archiveEnergyCTA = useCallback(() => {
    setShowEnergyCTA(false);
    setShowArchiveMessage(true);
    setTimeout(() => setShowArchiveMessage(false), 3000);
  }, []);

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
      updateGoal,
      logUnit,
      updateHabit,
      deleteHabit,
      saveHabitOrder,
      backfillMissedDays,
      setNewStartDate,
      onboardingSave,
      iconPress,
      emojiSelect,
    },
    ui: {
      showEnergyCTA,
      showArchiveMessage,
      archiveEnergyCTA,
      emojiHabitIndex,
    },
    setHabitsForTesting: storeSetHabits,
  };
};
