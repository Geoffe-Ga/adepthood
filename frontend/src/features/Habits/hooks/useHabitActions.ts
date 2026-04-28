import { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';

import { formatApiError } from '../../../api/errorMessages';
import { useOptimisticMutation } from '../../../hooks/useOptimisticMutation';
import type { HabitsActions, OnboardingHabit } from '../Habits.types';
import { habitManager, type LogUnitContext, type ShowToast } from '../services/habitManager';

import type { useHabitUI } from './useHabitUI';

/**
 * Wire `habitManager.{prepare,apply,commit,rollback}LogUnitContext` into
 * `useOptimisticMutation`. The hook owns the apply -> commit -> rollback
 * cycle (BUG-FE-HABIT-001) and only fires the milestone toast inside
 * `onSuccess` so a server-rejected check-in never flashes a celebration
 * the user didn't earn.
 */
const useLogUnitMutation = (
  showToast: ShowToast,
): ((_habitId: number, _amount: number) => void) => {
  const mutation = useOptimisticMutation<LogUnitContext, unknown>({
    apply: (ctx) => habitManager.applyLogUnitContext(ctx),
    commit: (ctx) => habitManager.commitLogUnitContext(ctx),
    rollback: (ctx, err) => {
      habitManager.rollbackLogUnitContext(ctx);
      Alert.alert(
        "Couldn't sync",
        formatApiError(err, {
          fallback:
            "We couldn't save that check-in. Your local copy was restored — check your connection and tap to log again.",
        }),
      );
    },
    onSuccess: (ctx) => {
      const toast = habitManager.buildLogUnitToast(ctx);
      if (toast) showToast(toast);
    },
  });

  return useCallback(
    (habitId: number, amount: number) => {
      const ctx = habitManager.prepareLogUnit(habitId, amount);
      if (!ctx) return;
      // Fire-and-forget: rollback runs inside the hook before the
      // re-throw; the Alert above already surfaced the failure to the
      // user, so swallow the rejection here to keep UI handlers tidy.
      mutation.mutate(ctx).catch(() => {});
    },
    [mutation],
  );
};

/**
 * Binds stateful callbacks — ones that read UI state such as `selectedHabit`
 * — around the stateless `habitManager` service. Returns a stable
 * `HabitsActions` object suitable for passing to memoized child components.
 */
export const useHabitActions = (
  ui: ReturnType<typeof useHabitUI>,
  showToast: ShowToast,
): HabitsActions => {
  const logUnit = useLogUnitMutation(showToast);

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
