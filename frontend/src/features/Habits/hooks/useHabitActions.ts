import { useCallback, useMemo, useRef } from 'react';

import { ApiError, ApiValidationError } from '../../../api';
import { formatApiError } from '../../../api/errorMessages';
import { colors } from '../../../design/tokens';
import { useOptimisticMutation } from '../../../hooks/useOptimisticMutation';
import { savePendingCheckIn } from '../../../storage/habitStorage';
import type { HabitMergePlan, HabitsActions, OnboardingHabit } from '../Habits.types';
import { habitManager, type LogUnitContext, type ShowToast } from '../services/habitManager';
import { ClientMintedIdError } from '../services/serverIds';

import type { useHabitUI } from './useHabitUI';

/** Toast icon for log-sync failures — visually distinct from milestone celebrations. */
const SYNC_ERROR_ICON = '\u{26A0}\u{FE0F}';

/** Show the rejection long enough to read on a phone before auto-dismiss. */
const SYNC_ERROR_TOAST_DURATION_MS = 6000;

/** Toast icon for an offline check-in that was queued for later sync. */
const OFFLINE_QUEUED_ICON = '\u{1F4F6}';

/** Toast icon for a tap on a sample tile — an invitation, not a warning. */
const DEMO_TILE_ICON = '\u{2728}';

/**
 * Any failed log on a demo-seed tile, offline or online. Those tiles' goal
 * ids are fabricated on-device, so no retry, queued check-in, or habit
 * refresh can ever make the POST land — only saying so is honest. The
 * optimistic increment stays: the tile is explorable, and ``persistHabits``
 * already keeps demo rows off disk.
 */
const showDemoSeedNotice = (showToast: ShowToast): void => {
  showToast({
    message:
      "These are sample habits to explore — this one isn't saved to your account. Add your own to start tracking.",
    icon: DEMO_TILE_ICON,
    color: colors.secondary,
    duration: SYNC_ERROR_TOAST_DURATION_MS,
  });
};

/**
 * A tap on a row whose ids this device minted. Its goal id names no server row,
 * so the check-in cannot be posted OR queued; the honest move is to say the
 * save is still in flight and resync in the background so the next tap lands.
 * Transient state rather than the user's mistake, so it wears the secondary
 * colour, not the danger one.
 */
const showClientMintedNotice = (showToast: ShowToast): void => {
  showToast({
    message:
      'This habit has not finished saving to your account yet, so your check-in was not recorded. Try again in a moment.',
    icon: SYNC_ERROR_ICON,
    color: colors.secondary,
    duration: SYNC_ERROR_TOAST_DURATION_MS,
  });
};

/** Keep an offline tap by queueing it for the next replay. */
const keepOfflineCheckIn = (ctx: LogUnitContext, goalId: number, showToast: ShowToast): void => {
  void savePendingCheckIn({
    goal_id: goalId,
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
};

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
  if (ctx.isDemoSeed === true) {
    // Ahead of every other branch: a demo tile fails online too — its
    // fabricated goal id draws a real ``goal_not_found``, which otherwise
    // reads as the stale-id symptom and triggers a refresh that can only
    // re-seed the same demo.
    showDemoSeedNotice(showToast);
    return;
  }
  if (err instanceof ClientMintedIdError) {
    // Two independent things keep a device-minted check-in out of the queue:
    // this branch sits above the offline one, and the offline branch separately
    // demands a server-issued id. Either alone would do — they are kept together
    // because the error carries no HTTP response, so a single lapse would let
    // the offline branch claim it and promise a sync no server row can answer.
    habitManager.rollbackLogUnitContext(ctx);
    void habitManager.loadHabits(tz);
    showClientMintedNotice(showToast);
    return;
  }
  if (!isServerResponse(err) && ctx.serverGoalId !== null) {
    // Offline: keep the optimistic state instead of throwing the tap away. The
    // id check is defence in depth at the queue boundary, mirroring the
    // wire-side guard, for a failure that reached here around the manager.
    keepOfflineCheckIn(ctx, ctx.serverGoalId, showToast);
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
  const { mutate } = useOptimisticMutation<LogUnitContext, unknown>({
    apply: (ctx) => habitManager.applyLogUnitContext(ctx),
    commit: (ctx) => habitManager.commitLogUnitContext(ctx),
    rollback: (ctx, err) => handleLogUnitFailure(ctx, err, showToast, tz),
    onSuccess: (ctx) => {
      if (ctx.isDemoSeed === true) {
        // ``commitLogUnitContext`` short-circuits a demo tile to ``null``, which
        // resolves — so this path, not ``rollback``, is where a sample tap lands.
        // Without the notice here the tile would hand out a milestone
        // celebration for a check-in that never left the device.
        showDemoSeedNotice(showToast);
        return;
      }
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
      mutate(ctx).catch(() => {});
    },
    [mutate, tz],
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

  const { setEmojiHabitIndex } = ui;

  const iconPress = useCallback((index: number) => setEmojiHabitIndex(index), [setEmojiHabitIndex]);

  // Latest-ref keeps emojiSelect referentially stable while it reads the
  // current picker target at call time.
  const emojiHabitIndexRef = useRef(ui.emojiHabitIndex);
  emojiHabitIndexRef.current = ui.emojiHabitIndex;

  const emojiSelect = useCallback(
    (emoji: string) => {
      const index = emojiHabitIndexRef.current;
      if (index !== null) habitManager.setEmojiForHabit(index, emoji);
      setEmojiHabitIndex(null);
    },
    [setEmojiHabitIndex],
  );

  // Passed straight through: the modal states either bare picks (a first run,
  // which has no row to name) or a plan it derived from the habits it just
  // showed the user, and the merge already speaks both.
  const onboardingSave = useCallback(
    (input: readonly OnboardingHabit[] | HabitMergePlan) =>
      habitManager.onboardingSave(input, showToast),
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
      // Bind the hook tz so a backfill buckets its completed_on days into the
      // user's stored zone, matching the online log path.
      backfillMissedDays: (habitId: number, days: Date[]) =>
        habitManager.backfillMissedDays(habitId, days, tz),
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
