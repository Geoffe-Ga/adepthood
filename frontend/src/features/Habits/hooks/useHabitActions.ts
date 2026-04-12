import { useCallback, useMemo } from 'react';

import type { HabitsActions, OnboardingHabit } from '../Habits.types';
import { habitManager, type ShowToast } from '../services/habitManager';

import type { useHabitUI } from './useHabitUI';

/**
 * Binds stateful callbacks — ones that read UI state such as `selectedHabit`
 * — around the stateless `habitManager` service. Returns a stable
 * `HabitsActions` object suitable for passing to memoized child components.
 */
export const useHabitActions = (
  ui: ReturnType<typeof useHabitUI>,
  showToast: ShowToast,
): HabitsActions => {
  const logUnit = useCallback(
    (habitId: number, amount: number) => {
      const updated = habitManager.logUnit(habitId, amount, showToast);
      if (updated && ui.selectedHabit?.id === habitId) ui.setSelectedHabit(updated);
    },
    [showToast, ui],
  );

  const iconPress = useCallback((index: number) => ui.setEmojiHabitIndex(index), [ui]);

  const emojiSelect = useCallback(
    (emoji: string) => {
      if (ui.emojiHabitIndex !== null) habitManager.setEmojiForHabit(ui.emojiHabitIndex, emoji);
      ui.setEmojiHabitIndex(null);
    },
    [ui],
  );

  const onboardingSave = useCallback(
    (newHabits: OnboardingHabit[]) => habitManager.onboardingSave(newHabits, showToast),
    [showToast],
  );

  return useMemo(
    () => ({
      loadHabits: habitManager.loadHabits,
      updateGoal: habitManager.updateGoal,
      logUnit,
      updateHabit: habitManager.updateHabit,
      deleteHabit: habitManager.deleteHabit,
      saveHabitOrder: habitManager.saveHabitOrder,
      backfillMissedDays: habitManager.backfillMissedDays,
      setNewStartDate: habitManager.setNewStartDate,
      onboardingSave,
      iconPress,
      emojiSelect,
      revealAllHabits: habitManager.revealAllHabits,
      lockUnstartedHabits: habitManager.lockUnstartedHabits,
      unlockHabit: habitManager.unlockHabit,
    }),
    [logUnit, iconPress, emojiSelect, onboardingSave],
  );
};
