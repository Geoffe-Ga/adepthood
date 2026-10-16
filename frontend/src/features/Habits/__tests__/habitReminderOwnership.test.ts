/**
 * #3334: a native Habit reminder belongs to the account that scheduled it.
 *
 * ``updateHabitNotifications`` awaits a mapping read, native cancellation and
 * native scheduling before it records the new ids, and the storage it records
 * into resolves the account namespace at call time. A schedule started under
 * account A that settled after a switch to B used to save A's ids into B's
 * mappings and leave A's reminder live on the device. These specs hold the
 * native calls open with real deferreds over the real notification storage and
 * the real account scope, then move the account underneath them.
 *
 * Bounded evidence: ``expo-notifications`` is the Jest manual mock here, so
 * this proves what the app asks the native module to do, not what any OS
 * scheduler does with it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Habit } from '../Habits.types';
import {
  cancelForHabit,
  reconcileNotifications,
  updateHabitNotifications,
} from '../hooks/useHabitNotifications';

import { reportDiagnostic } from '@/observability/diagnostics';
import {
  clearAllNotificationData,
  loadAllNotificationMappings,
  loadNotificationIds,
  saveNotificationIds,
} from '@/storage/notificationStorage';
import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

jest.mock('@/observability/diagnostics', () => ({ reportDiagnostic: jest.fn() }));

const USER_A = 1;
const USER_B = 2;
const HABIT_ID = 7;

type Mocked<T> = jest.MockedFunction<T extends (...args: never[]) => unknown ? T : never>;

const schedule = Notifications.scheduleNotificationAsync as unknown as Mocked<
  () => Promise<string>
>;
const cancel = Notifications.cancelScheduledNotificationAsync as unknown as Mocked<
  (id: string) => Promise<void>
>;
const cancelAll = (
  Notifications as unknown as { cancelAllScheduledNotificationsAsync: Mocked<() => Promise<void>> }
).cancelAllScheduledNotificationsAsync;
const listScheduled = Notifications.getAllScheduledNotificationsAsync as unknown as Mocked<
  () => Promise<Array<{ identifier: string }>>
>;
const diagnostics = reportDiagnostic as jest.MockedFunction<typeof reportDiagnostic>;

const habit = (overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Sit',
  icon: '🪷',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2026-01-01T00:00:00Z'),
  goals: [],
  notificationFrequency: 'daily',
  notificationTimes: ['08:00'],
  ...overrides,
});

interface Held<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

/** Read one account's mapping and tracking list, whatever account is live. */
async function mappingsOf(owner: number | null): Promise<Record<number, string[]>> {
  setActiveUser(owner);
  return loadAllNotificationMappings();
}

/** The account switch ``adoptDeviceOwner`` performs: wipe under the old owner, then adopt. */
async function switchAccount(to: number | null): Promise<void> {
  beginActiveUserTransition();
  await clearAllNotificationData();
  setActiveUser(to);
}

beforeEach(async () => {
  jest.clearAllMocks();
  setActiveUser(null);
  await AsyncStorage.clear();
  schedule.mockResolvedValue('scheduled-id');
  cancel.mockResolvedValue(undefined);
  cancelAll.mockResolvedValue(undefined);
  listScheduled.mockResolvedValue([]);
  setActiveUser(USER_A);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a held native schedule that settles after the account moved', () => {
  it('A to B: saves nothing into B and cancels the late A reminder', async () => {
    const native = held<string>();
    schedule.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit());
    await flush();
    expect(schedule).toHaveBeenCalledTimes(1);

    await switchAccount(USER_B);
    native.resolve('a-late');
    await expect(update).resolves.toEqual([]);

    expect(await loadNotificationIds(HABIT_ID)).toEqual([]);
    expect(await mappingsOf(USER_B)).toEqual({});
    expect(await mappingsOf(USER_A)).toEqual({});
    expect(cancel).toHaveBeenCalledWith('a-late');
  });

  it('A to B to A: the returning A does not adopt the stale schedule', async () => {
    const native = held<string>();
    schedule.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit());
    await flush();
    await switchAccount(USER_B);
    await switchAccount(USER_A);
    native.resolve('a-late');
    await expect(update).resolves.toEqual([]);

    expect(await mappingsOf(USER_A)).toEqual({});
    expect(await mappingsOf(USER_B)).toEqual({});
    expect(cancel).toHaveBeenCalledWith('a-late');
  });

  it('settling mid-cleanup writes nothing back into the departing namespace', async () => {
    const native = held<string>();
    schedule.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit());
    await flush();
    beginActiveUserTransition();
    await clearAllNotificationData();
    native.resolve('a-late');
    await expect(update).resolves.toEqual([]);
    setActiveUser(null);

    expect(await mappingsOf(USER_A)).toEqual({});
    expect(cancel).toHaveBeenCalledWith('a-late');
  });

  it('does not retry a failed first attempt for an account that has gone', async () => {
    const native = held<string>();
    schedule.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit());
    await flush();
    await switchAccount(USER_B);
    native.reject(new Error('native scheduler busy'));
    await expect(update).resolves.toEqual([]);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(await mappingsOf(USER_B)).toEqual({});
  });

  it('stops scheduling the remaining times once the account moves', async () => {
    const first = held<string>();
    schedule.mockReturnValueOnce(first.promise);

    const update = updateHabitNotifications(habit({ notificationTimes: ['08:00', '20:00'] }));
    await flush();
    await switchAccount(USER_B);
    first.resolve('a-morning');
    await expect(update).resolves.toEqual([]);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('a-morning');
    expect(await mappingsOf(USER_B)).toEqual({});
  });

  it('a held cancellation of A’s old reminder schedules nothing for B', async () => {
    await saveNotificationIds(HABIT_ID, ['a-old']);
    const native = held<undefined>();
    cancel.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit());
    await flush();
    expect(cancel).toHaveBeenCalledWith('a-old');
    await switchAccount(USER_B);
    native.resolve(undefined);
    await expect(update).resolves.toEqual([]);

    expect(schedule).not.toHaveBeenCalled();
    expect(await mappingsOf(USER_B)).toEqual({});
  });

  it('turning reminders off under a held cancellation clears nothing in B', async () => {
    setActiveUser(USER_B);
    await saveNotificationIds(HABIT_ID, ['b-own']);
    setActiveUser(USER_A);
    await saveNotificationIds(HABIT_ID, ['a-old']);
    const native = held<undefined>();
    cancel.mockReturnValueOnce(native.promise);

    const update = updateHabitNotifications(habit({ notificationFrequency: 'off' }));
    await flush();
    beginActiveUserTransition();
    setActiveUser(USER_B);
    native.resolve(undefined);
    await expect(update).resolves.toEqual([]);

    expect(await mappingsOf(USER_B)).toEqual({ [HABIT_ID]: ['b-own'] });
  });

  it('a held bookkeeping write that lands after the switch is taken back out', async () => {
    const setItem = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;
    const real = setItem.getMockImplementation();
    const write = held<undefined>();
    setItem.mockImplementationOnce(async (key, value) => {
      await write.promise;
      await real?.(key, value);
    });
    schedule.mockResolvedValueOnce('a-recorded-late');

    const update = updateHabitNotifications(habit());
    await flush();
    await switchAccount(USER_B);
    write.resolve(undefined);
    await expect(update).resolves.toEqual([]);

    expect(cancel).toHaveBeenCalledWith('a-recorded-late');
    expect(await mappingsOf(USER_A)).toEqual({});
    expect(await mappingsOf(USER_B)).toEqual({});
  });

  it('a habit deleted under A clears A’s record even if the cancel settles under B', async () => {
    setActiveUser(USER_B);
    await saveNotificationIds(HABIT_ID, ['b-own']);
    setActiveUser(USER_A);
    await saveNotificationIds(HABIT_ID, ['a-old']);
    const native = held<undefined>();
    cancel.mockReturnValueOnce(native.promise);

    const deletion = cancelForHabit(HABIT_ID);
    await flush();
    setActiveUser(USER_B);
    native.resolve(undefined);
    await deletion;

    expect(cancel).toHaveBeenCalledWith('a-old');
    expect(await mappingsOf(USER_B)).toEqual({ [HABIT_ID]: ['b-own'] });
    expect(await mappingsOf(USER_A)).toEqual({});
  });

  it('refuses to start while account cleanup is running', async () => {
    beginActiveUserTransition();
    await expect(updateHabitNotifications(habit())).resolves.toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('same-account controls', () => {
  it('schedules and records under the account that asked', async () => {
    await expect(updateHabitNotifications(habit())).resolves.toEqual(['scheduled-id']);
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['scheduled-id'] });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('replaces the previous reminder with the new one', async () => {
    await saveNotificationIds(HABIT_ID, ['a-old']);
    schedule.mockResolvedValueOnce('a-new');
    await expect(updateHabitNotifications(habit())).resolves.toEqual(['a-new']);
    expect(cancel).toHaveBeenCalledWith('a-old');
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['a-new'] });
  });

  it('retries one failed attempt and records the retry', async () => {
    schedule.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce('a-retry');
    await expect(updateHabitNotifications(habit())).resolves.toEqual(['a-retry']);
    expect(diagnostics).toHaveBeenCalledWith('notification_schedule_retry');
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['a-retry'] });
  });

  it('records nothing and reports when both attempts fail', async () => {
    schedule.mockRejectedValue(new Error('denied'));
    await expect(updateHabitNotifications(habit())).resolves.toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith('notification_schedule_failed');
    expect(await mappingsOf(USER_A)).toEqual({});
  });

  it('cancels a partly scheduled attempt before retrying, so no orphan stays live', async () => {
    schedule
      .mockResolvedValueOnce('a-mon')
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce('a-mon-2')
      .mockResolvedValueOnce('a-wed-2');
    const custom = habit({ notificationFrequency: 'custom', notificationDays: ['Mon', 'Wed'] });
    await expect(updateHabitNotifications(custom)).resolves.toEqual(['a-mon-2', 'a-wed-2']);
    expect(cancel).toHaveBeenCalledWith('a-mon');
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['a-mon-2', 'a-wed-2'] });
  });

  it('a failed cancellation schedules nothing new and keeps the old record for a retry', async () => {
    await saveNotificationIds(HABIT_ID, ['a-old']);
    cancel.mockRejectedValueOnce(new Error('native cancel failed'));
    await expect(updateHabitNotifications(habit())).resolves.toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith('notification_update_failed');
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['a-old'] });
  });

  it('a bookkeeping failure cancels the reminder it could not record', async () => {
    schedule.mockResolvedValueOnce('a-unrecorded');
    const setItem = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;
    setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(updateHabitNotifications(habit())).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledWith('a-unrecorded');
    expect(diagnostics).toHaveBeenCalledWith('notification_update_failed');
    expect(await mappingsOf(USER_A)).toEqual({});
  });

  it('turning reminders off cancels the old one and clears the record', async () => {
    await saveNotificationIds(HABIT_ID, ['a-old']);
    await expect(
      updateHabitNotifications(habit({ notificationFrequency: 'off' })),
    ).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledWith('a-old');
    expect(schedule).not.toHaveBeenCalled();
    expect(await mappingsOf(USER_A)).toEqual({});
  });
});

describe('logout and restart cover the reminders on the device', () => {
  it('logout cleanup cancels the native reminders, not just the records', async () => {
    await saveNotificationIds(HABIT_ID, ['a-live']);
    beginActiveUserTransition();
    await clearAllNotificationData();
    setActiveUser(null);

    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(await mappingsOf(USER_A)).toEqual({});
  });

  it('a failed native cancel still clears the records and is reported', async () => {
    await saveNotificationIds(HABIT_ID, ['a-live']);
    cancelAll.mockRejectedValueOnce(new Error('native module gone'));
    beginActiveUserTransition();
    await expect(clearAllNotificationData()).resolves.toBeUndefined();
    setActiveUser(null);

    expect(diagnostics).toHaveBeenCalledWith('notification_cancel_failed');
    expect(await mappingsOf(USER_A)).toEqual({});
  });

  it('web has no native schedule to cancel, so logout does not touch or report it', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await clearAllNotificationData();
    expect(cancelAll).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalledWith('notification_cancel_failed');
  });

  it('the next account’s start-up reconcile cancels a reminder a failed logout left behind', async () => {
    await saveNotificationIds(HABIT_ID, ['a-live']);
    cancelAll.mockRejectedValueOnce(new Error('native module gone'));
    await switchAccount(USER_B);
    await saveNotificationIds(3, ['b-live']);
    listScheduled.mockResolvedValueOnce([{ identifier: 'a-live' }, { identifier: 'b-live' }]);

    await reconcileNotifications();

    expect(cancel).toHaveBeenCalledWith('a-live');
    expect(cancel).not.toHaveBeenCalledWith('b-live');
    expect(await mappingsOf(USER_B)).toEqual({ 3: ['b-live'] });
  });

  it('a reconcile the account moved under cancels and rewrites nothing', async () => {
    await saveNotificationIds(HABIT_ID, ['a-gone']);
    const inventory = held<Array<{ identifier: string }>>();
    listScheduled.mockReturnValueOnce(inventory.promise);

    const reconcile = reconcileNotifications();
    await flush();
    setActiveUser(USER_B);
    await saveNotificationIds(3, ['b-live']);
    inventory.resolve([{ identifier: 'b-live' }]);
    await reconcile;

    expect(cancel).not.toHaveBeenCalled();
    expect(await mappingsOf(USER_B)).toEqual({ 3: ['b-live'] });
    expect(await mappingsOf(USER_A)).toEqual({ [HABIT_ID]: ['a-gone'] });
  });
});
