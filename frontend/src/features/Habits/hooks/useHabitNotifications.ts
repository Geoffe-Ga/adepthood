import * as Notifications from 'expo-notifications';

import {
  saveNotificationIds,
  loadNotificationIds,
  clearNotificationIds,
  loadAllNotificationMappings,
  savePushToken,
  loadPushToken,
  captureNotificationNamespace,
  type NotificationNamespace,
} from '../../../storage/notificationStorage';
import {
  getActiveUser,
  getActiveUserGeneration,
  isAccountScopeCurrent,
  isActiveUserTransitioning,
} from '../../../storage/userScope';
import { DAYS_OF_WEEK } from '../constants';
import type { Habit } from '../Habits.types';

import { reportDiagnostic } from '@/observability/diagnostics';

const MAX_REGISTRATION_RETRIES = 3;
const REGISTRATION_RETRY_DELAY_MS = 30_000;

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted ?? false;

// Cancelable delay: aborting resolves immediately and clears the pending timer.
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const registerForPushNotificationsAsync = async (
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const cached = await loadPushToken();
  if (cached) return cached;

  return attemptPushRegistration(0, signal);
};

const attemptPushRegistration = async (
  attempt: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return undefined;
    }
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    await savePushToken(token);
    return token;
  } catch {
    reportDiagnostic('notification_registration_failed', { attempt: attempt + 1 });
    if (attempt < MAX_REGISTRATION_RETRIES - 1) {
      return retryAfterDelay(attempt, signal);
    }
    return undefined;
  }
};

const retryAfterDelay = async (
  attempt: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if (isAborted(signal)) return undefined;
  await wait(REGISTRATION_RETRY_DELAY_MS, signal);
  if (isAborted(signal)) return undefined;
  return attemptPushRegistration(attempt + 1, signal);
};

const buildDailyTrigger = (hours: number, minutes: number): Notifications.DailyTriggerInput => ({
  type: Notifications.SchedulableTriggerInputTypes.DAILY,
  hour: hours,
  minute: minutes,
});

const buildWeeklyTrigger = (
  weekday: number,
  hours: number,
  minutes: number,
): Notifications.WeeklyTriggerInput => ({
  type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
  weekday,
  hour: hours,
  minute: minutes,
});

/**
 * The account a reminder operation was started for (#3334).
 *
 * Scheduling is a chain of native and storage awaits, and the account can move
 * during any of them. Every step after an await asks ``current()`` before it
 * acts, and every record goes to ``namespace``, the starting account's own
 * keys, so a late step can neither write into another account's mappings nor
 * keep a reminder live for an account that has gone. The owner alone is not
 * enough (A to B to A puts A back), so the generation is compared too; and
 * nothing is current while account cleanup runs.
 */
interface ReminderScope {
  authorized: boolean;
  current: () => boolean;
  namespace: NotificationNamespace;
}

const captureReminderScope = (): ReminderScope => {
  const owner = getActiveUser();
  const epoch = getActiveUserGeneration();
  return {
    authorized: !isActiveUserTransitioning(),
    current: () => !isActiveUserTransitioning() && isAccountScopeCurrent(owner, epoch),
    namespace: captureNotificationNamespace(),
  };
};

/** The scheduling pass lost its account: what it already scheduled must not stay live. */
class ReminderScopeLost extends Error {}

/**
 * Best-effort native cancel of reminders this operation itself scheduled and
 * will not record. A failure is reported; the next start-up reconcile cancels
 * any reminder the records do not name.
 */
const withdrawScheduled = async (ids: readonly string[]): Promise<void> => {
  const results = await Promise.allSettled(
    ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
  );
  if (results.some((result) => result.status === 'rejected')) {
    reportDiagnostic('notification_cancel_failed');
  }
};

/**
 * Schedule one reminder and append its id to ``sink`` the moment the native
 * call answers, so a caller whose later call fails still knows every reminder
 * that is already live and can withdraw it.
 */
const scheduleOne = async (
  habit: Habit,
  trigger: Notifications.NotificationTriggerInput,
  sink: string[],
): Promise<void> => {
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: `Time for: ${habit.name}`,
      body: 'A reminder, if today has room for it.',
      data: { habitId: habit.id },
    },
    trigger,
  });
  sink.push(id);
};

const scheduleCustomDays = async (
  habit: Habit,
  hours: number,
  minutes: number,
  sink: string[],
): Promise<void> => {
  for (const day of habit.notificationDays ?? []) {
    const weekday = DAYS_OF_WEEK.indexOf(day) + 1;
    await scheduleOne(habit, buildWeeklyTrigger(weekday, hours, minutes), sink);
  }
};

const scheduleInto = async (
  habit: Habit,
  notificationTime: string,
  sink: string[],
): Promise<void> => {
  const [hours = 0, minutes = 0] = notificationTime.split(':').map(Number);

  if (habit.notificationFrequency === 'weekly') {
    await scheduleOne(habit, buildWeeklyTrigger(1, hours, minutes), sink);
    return;
  }
  const hasCustomDays =
    habit.notificationFrequency === 'custom' &&
    habit.notificationDays &&
    habit.notificationDays.length > 0;
  if (hasCustomDays) {
    await scheduleCustomDays(habit, hours, minutes, sink);
    return;
  }
  // 'daily', and the fallback for any other cadence.
  await scheduleOne(habit, buildDailyTrigger(hours, minutes), sink);
};

export const scheduleHabitNotification = async (
  habit: Habit,
  notificationTime: string,
): Promise<string[]> => {
  const ids: string[] = [];
  await scheduleInto(habit, notificationTime, ids);
  return ids;
};

const remindersOff = (habit: Habit): boolean =>
  habit.notificationFrequency === 'off' ||
  !habit.notificationTimes ||
  habit.notificationTimes.length === 0;

/** Cancel the reminder being replaced. A failure rejects, so nothing new doubles it. */
const cancelPrevious = async (
  habit: Habit,
  habitId: number,
  scope: ReminderScope,
): Promise<void> => {
  const persistedIds = await loadNotificationIds(habitId, scope.namespace);
  if (!scope.current()) throw new ReminderScopeLost();
  const idsToCancel =
    habit.notificationIds && habit.notificationIds.length > 0
      ? habit.notificationIds
      : persistedIds;
  if (idsToCancel.length > 0) {
    await Promise.all(idsToCancel.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
  }
};

/**
 * Record the new ids, or withdraw the reminders when they cannot be recorded.
 * A reminder no record names is one nothing will ever cancel deliberately, so
 * a failed write cancels it rather than leaving it to fire unowned.
 */
const recordScheduled = async (
  habitId: number,
  ids: string[],
  scope: ReminderScope,
): Promise<string[]> => {
  try {
    await saveNotificationIds(habitId, ids, scope.namespace);
  } catch {
    reportDiagnostic('notification_update_failed');
    await withdrawScheduled(ids);
    await clearNotificationIds(habitId, scope.namespace).catch(() => undefined);
    return [];
  }
  if (scope.current()) return ids;
  // The write landed after the account moved (into its own, now wiped, keys):
  // take the reminder and the record back out.
  await withdrawScheduled(ids);
  const recorded = await loadNotificationIds(habitId, scope.namespace);
  if (recorded.join('\n') === ids.join('\n')) {
    await clearNotificationIds(habitId, scope.namespace);
  }
  return [];
};

const rescheduleWithinScope = async (
  habit: Habit,
  habitId: number,
  scope: ReminderScope,
): Promise<string[]> => {
  await cancelPrevious(habit, habitId, scope);
  if (!scope.current()) return [];
  if (remindersOff(habit)) {
    await clearNotificationIds(habitId, scope.namespace);
    return [];
  }
  const ids = await scheduleNotificationsWithRetry(habit, scope);
  if (!scope.current()) {
    await withdrawScheduled(ids);
    return [];
  }
  return recordScheduled(habitId, ids, scope);
};

/**
 * Replace a habit's device reminders and record them for the account that
 * asked (#3334). Resolves ``[]`` whenever nothing was left scheduled: reminders
 * off, a native or storage failure, or the account moving mid-flight, in which
 * case anything this call scheduled is cancelled again.
 */
export const updateHabitNotifications = async (habit: Habit): Promise<string[]> => {
  if (!habit.id) return [];
  const scope = captureReminderScope();
  if (!scope.authorized) return [];
  try {
    return await rescheduleWithinScope(habit, habit.id, scope);
  } catch (error) {
    if (!(error instanceof ReminderScopeLost)) reportDiagnostic('notification_update_failed');
    return [];
  }
};

const scheduleNotificationsWithRetry = async (
  habit: Habit,
  scope: ReminderScope,
): Promise<string[]> => {
  try {
    return await scheduleAllTimes(habit, scope);
  } catch (error) {
    if (error instanceof ReminderScopeLost || !scope.current()) throw new ReminderScopeLost();
    reportDiagnostic('notification_schedule_retry');
  }
  // Single retry outside the first catch to avoid nested try/catch
  try {
    return await scheduleAllTimes(habit, scope);
  } catch (retryError) {
    if (!(retryError instanceof ReminderScopeLost))
      reportDiagnostic('notification_schedule_failed');
    throw retryError;
  }
};

/**
 * Schedule every time, all or nothing. A pass that fails, or that outlives
 * its account, withdraws what it had already scheduled before it rethrows, so
 * a retry starts clean and no partial reminder stays live unrecorded.
 */
const scheduleAllTimes = async (habit: Habit, scope: ReminderScope): Promise<string[]> => {
  const notificationIds: string[] = [];
  try {
    for (const notificationTime of habit.notificationTimes ?? []) {
      if (!scope.current()) throw new ReminderScopeLost();
      await scheduleInto(habit, notificationTime, notificationIds);
    }
  } catch (error) {
    await withdrawScheduled(notificationIds);
    throw error;
  }
  return notificationIds;
};

/**
 * Bring the device's reminders and this account's records back into step:
 * cancel reminders no record names (including any an earlier account's failed
 * logout left behind) and drop records whose reminders are gone. The whole
 * pass belongs to the account live when it began (#3334); if the account moves
 * while the native inventory is in flight, the pass stops without cancelling
 * or rewriting anything, because the records it compared against are no
 * longer the live account's.
 */
export const reconcileNotifications = async (signal?: AbortSignal): Promise<void> => {
  const scope = captureReminderScope();
  const live = (): boolean => !isAborted(signal) && scope.current();
  try {
    if (!scope.authorized || !live()) return;
    const persisted = await loadAllNotificationMappings(scope.namespace);
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    // Abort mid-flight (e.g. unmount) must not cancel or rewrite anything.
    if (!live()) return;
    await cancelOrphans(scheduled, new Set(Object.values(persisted).flat()), live);
    await pruneRecords(persisted, new Set(scheduled.map((n) => n.identifier)), scope, live);
  } catch {
    reportDiagnostic('notification_reconcile_failed');
  }
};

/** Cancel notifications scheduled on the device that no record names. */
const cancelOrphans = async (
  scheduled: ReadonlyArray<{ identifier: string }>,
  recordedIds: ReadonlySet<string>,
  live: () => boolean,
): Promise<void> => {
  for (const notification of scheduled) {
    if (!live()) return;
    if (!recordedIds.has(notification.identifier)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
};

/** Drop recorded ids whose notifications are no longer scheduled. */
const pruneRecords = async (
  persisted: Record<number, string[]>,
  scheduledIds: ReadonlySet<string>,
  scope: ReminderScope,
  live: () => boolean,
): Promise<void> => {
  for (const [habitIdStr, ids] of Object.entries(persisted)) {
    if (!live()) return;
    const habitId = Number(habitIdStr);
    const stillScheduled = ids.filter((id) => scheduledIds.has(id));
    if (stillScheduled.length === 0) {
      await clearNotificationIds(habitId, scope.namespace);
    } else if (stillScheduled.length !== ids.length) {
      await saveNotificationIds(habitId, stillScheduled, scope.namespace);
    }
  }
};

/**
 * Cancel a deleted habit's reminders. The ids are the deleting account's, read
 * from its namespace, and the record cleared is that same namespace's, even if
 * the account moves while the native cancel is in flight (#3334).
 */
export const cancelForHabit = async (habitId: number): Promise<void> => {
  const namespace = captureNotificationNamespace();
  try {
    const ids = await loadNotificationIds(habitId, namespace);
    await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
    await clearNotificationIds(habitId, namespace);
  } catch {
    reportDiagnostic('notification_cancel_failed');
  }
};
