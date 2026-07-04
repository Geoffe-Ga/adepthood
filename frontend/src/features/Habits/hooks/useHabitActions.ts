import { useCallback, useMemo } from 'react';

import { ApiError, ApiValidationError } from '../../../api';
import { formatApiError } from '../../../api/errorMessages';
import { colors } from '../../../design/tokens';
import { useOptimisticMutation } from '../../../hooks/useOptimisticMutation';
import { savePendingCheckIn } from '../../../storage/habitStorage';
import type { HabitsActions, OnboardingHabit } from '../Habits.types';
import { habitManager, type LogUnitContext, type ShowToast } from '../services/habitManager';

import type { useHabitUI } from './useHabitUI';

/** Toast icon for log-sync failures — visually distinct from milestone celebrations. */
const SYNC_ERROR_ICON = '\u{26A0}\u{FE0F}';

/** Show the rejection long enough to read on a phone before auto-dismiss. */
const SYNC_ERROR_TOAST_DURATION_MS = 6000;

/** Toast icon for an offline check-in that was queued for later sync. */
const OFFLINE_QUEUED_ICON = '\u{1F4F6}';

/**
 * The server spoke (an HTTP status or a response that failed validation) —
 * the request is not retryable as-is, so the optimistic update must revert.
 * Anything else (fetch TypeError, DNS failure, airplane mode) is a network
 * problem the pending-check-in queue exists for.
 */
const isServerResponse = (err: unknown): boolean =>
  err instanceof ApiError || err instanceof ApiValidationError;

/**
 * The stale-synthetic-ID symptom (issue #282): onboarding's POSTs landed
 * but the trailing ``loadHabits`` refresh failed, so the store still
 * holds goal ids the server has never issued — every check-in 404s with
 * ``goal_not_found`` until the ids are resynced.
 */
const isStaleGoalIdError = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 404 && err.detail === 'goal_not_found';

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
const handleLogUnitFailure = (
  ctx: LogUnitContext,
  err: unknown,
  showToast: ShowToast,
  tz: string,
): void => {
  if (!isServerResponse(err) && ctx.currentGoal.id != null) {
    // Offline: keep the optimistic state and queue the check-in for
    // the next loadHabits replay instead of throwing the tap away.
    void savePendingCheckIn({
      goal_id: ctx.currentGoal.id,
      did_complete: true,
      timestamp: new Date().toISOString(),
      completed_on: ctx.completedOn,
    });
    showToast({
      message: "You're offline — check-in saved on this device. It will sync when you reconnect.",
      icon: OFFLINE_QUEUED_ICON,
      color: colors.secondary,
      duration: SYNC_ERROR_TOAST_DURATION_MS,
    });
    return;
  }
  habitManager.rollbackLogUnitContext(ctx);
  if (isStaleGoalIdError(err)) {
    // Issue #282 recovery path: re-fetch the server's authoritative
    // ids in the background so the user's NEXT tap succeeds, instead
    // of leaving them stuck until an app restart.
    void habitManager.loadHabits(tz);
    showToast({
      message:
        'Your habits were out of sync with the server — we just refreshed them. Tap to log that unit again.',
      icon: SYNC_ERROR_ICON,
      color: colors.danger,
      duration: SYNC_ERROR_TOAST_DURATION_MS,
    });
    return;
  }
  showToast({
    message: formatApiError(err, {
      fallback:
        "We couldn't save that check-in. Your local copy was restored — check your connection and tap to log again.",
    }),
    icon: SYNC_ERROR_ICON,
    color: colors.danger,
    duration: SYNC_ERROR_TOAST_DURATION_MS,
  });
};

const useLogUnitMutation = (
  showToast: ShowToast,
  tz: string,
): ((_habitId: number, _amount: number, _date?: Date) => void) => {
  const mutation = useOptimisticMutation<LogUnitContext, unknown>({
    apply: (ctx) => habitManager.applyLogUnitContext(ctx),
    commit: (ctx) => habitManager.commitLogUnitContext(ctx),
    rollback: (ctx, err) => handleLogUnitFailure(ctx, err, showToast, tz),
    onSuccess: (ctx) => {
      showToast(habitManager.buildLogUnitToast(ctx));
    },
  });

  return useCallback(
    (habitId: number, amount: number, date?: Date) => {
      const ctx = habitManager.prepareLogUnit(habitId, amount, tz, date);
      if (!ctx) return;
      // Fire-and-forget: rollback runs inside the hook before the re-throw
      // and has already surfaced the failure to the user via ``showToast``,
      // so swallow the rejection here to keep UI handlers tidy.
      mutation.mutate(ctx).catch(() => {});
    },
    [mutation, tz],
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
  tz: string,
): HabitsActions => {
  const logUnit = useLogUnitMutation(showToast, tz);

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
      // Bound so retries replay queued check-ins against the stored zone (#269).
      loadHabits: () => habitManager.loadHabits(tz),
      updateGoal: habitManager.updateGoal,
      updateGoalUnits: habitManager.updateGoalUnits,
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
      lockUntouchedHabits: habitManager.lockUntouchedHabits,
      unlockHabit: habitManager.unlockHabit,
    }),
    [logUnit, iconPress, emojiSelect, onboardingSave, tz],
  );
};
