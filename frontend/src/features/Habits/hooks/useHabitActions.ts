import { useCallback, useMemo } from 'react';

import { formatApiError } from '../../../api/errorMessages';
import { colors } from '../../../design/tokens';
import { useOptimisticMutation } from '../../../hooks/useOptimisticMutation';
import type { HabitsActions, OnboardingHabit } from '../Habits.types';
import { habitManager, type LogUnitContext, type ShowToast } from '../services/habitManager';

import type { useHabitUI } from './useHabitUI';

/** Toast icon for log-sync failures — visually distinct from milestone celebrations. */
const SYNC_ERROR_ICON = '\u{26A0}\u{FE0F}';

/** Show the rejection long enough to read on a phone before auto-dismiss. */
const SYNC_ERROR_TOAST_DURATION_MS = 6000;

/**
 * Wire `habitManager.{prepare,apply,commit,rollback}LogUnitContext` into
 * `useOptimisticMutation`. The hook owns the apply -> commit -> rollback
 * cycle (BUG-FE-HABIT-001) and only fires the milestone toast inside
 * `onSuccess` so a server-rejected check-in never flashes a celebration
 * the user didn't earn.
 *
 * Rollback feedback flows through ``showToast`` rather than ``Alert.alert``:
 * on React Native Web mobile browsers the platform Alert reduces to a
 * no-op, so a server rejection produced a "brief flash and then nothing"
 * with no error visible. The ToastProvider renders identically across
 * native and web, so the rejection now always reaches the user.
 */
const useLogUnitMutation = (
  showToast: ShowToast,
): ((_habitId: number, _amount: number) => void) => {
  const mutation = useOptimisticMutation<LogUnitContext, unknown>({
    apply: (ctx) => habitManager.applyLogUnitContext(ctx),
    commit: (ctx) => habitManager.commitLogUnitContext(ctx),
    rollback: (ctx, err) => {
      habitManager.rollbackLogUnitContext(ctx);
      showToast({
        message: formatApiError(err, {
          fallback:
            "We couldn't save that check-in. Your local copy was restored — check your connection and tap to log again.",
        }),
        icon: SYNC_ERROR_ICON,
        color: colors.danger,
        duration: SYNC_ERROR_TOAST_DURATION_MS,
      });
    },
    onSuccess: (ctx) => {
      showToast(habitManager.buildLogUnitToast(ctx));
    },
  });

  return useCallback(
    (habitId: number, amount: number) => {
      const ctx = habitManager.prepareLogUnit(habitId, amount);
      if (!ctx) return;
      // Fire-and-forget: rollback runs inside the hook before the re-throw
      // and has already surfaced the failure to the user via ``showToast``,
      // so swallow the rejection here to keep UI handlers tidy.
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
      addHabit: habitManager.addHabit,
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
