/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../../features/Habits/Habits.types';
import type { DroppedCheckIn } from '../habitStorage';
import {
  MAX_DROPPED_CHECK_INS,
  saveHabits,
  loadHabits,
  clearHabits,
  savePendingCheckIn,
  loadPendingCheckIns,
  replacePendingCheckIns,
  clearPendingCheckIns,
  recordDroppedCheckIn,
  loadDroppedCheckIns,
  clearDroppedCheckIns,
} from '../habitStorage';
import { _resetSerializedWriteForTests } from '../serializedWrite';
import { setActiveUser } from '../userScope';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const sampleHabit: Habit = {
  id: 1,
  stage: 'Beige',
  name: 'Meditate',
  icon: '🧘',
  streak: 5,
  energy_cost: 2,
  energy_return: 4,
  start_date: new Date('2024-06-01T00:00:00.000Z'),
  goals: [
    {
      id: 1,
      title: 'Low goal',
      tier: 'low',
      target: 10,
      target_unit: 'minutes',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [
    {
      id: 'c-1',
      timestamp: new Date('2024-06-10T08:30:00.000Z'),
      completed_units: 15,
    },
  ],
  last_completion_date: new Date('2024-06-10T08:30:00.000Z'),
  revealed: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
});

describe('habitStorage', () => {
  describe('saveHabits', () => {
    test('serializes habits and stores to AsyncStorage', async () => {
      await saveHabits([sampleHabit]);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/habits',
        expect.any(String),
      );

      // Verify the stored value is valid JSON
      const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
      const parsed = JSON.parse(stored);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('Meditate');
    });

    test('serializes Date fields as ISO strings', async () => {
      await saveHabits([sampleHabit]);

      const stored = mockAsyncStorage.setItem.mock.calls[0]![1] as string;
      const parsed = JSON.parse(stored);
      expect(parsed[0].start_date).toBe('2024-06-01T00:00:00.000Z');
      expect(parsed[0].last_completion_date).toBe('2024-06-10T08:30:00.000Z');
      expect(parsed[0].completions[0].timestamp).toBe('2024-06-10T08:30:00.000Z');
    });
  });

  describe('loadHabits', () => {
    test('returns null when no data stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      const result = await loadHabits();
      expect(result).toBeNull();
    });

    test('deserializes habits and rehydrates Date fields', async () => {
      const stored = JSON.stringify([sampleHabit]);
      mockAsyncStorage.getItem.mockResolvedValueOnce(stored);

      const result = await loadHabits();
      expect(result).toHaveLength(1);

      const habit = result![0]!;
      expect(habit.name).toBe('Meditate');
      expect(habit.start_date).toBeInstanceOf(Date);
      expect(habit.start_date.toISOString()).toBe('2024-06-01T00:00:00.000Z');
      expect(habit.last_completion_date).toBeInstanceOf(Date);
      expect(habit.completions![0]!.timestamp).toBeInstanceOf(Date);
    });

    test('handles habits without optional Date fields', async () => {
      const minimal: Habit = {
        id: 2,
        stage: 'Red',
        name: 'Run',
        icon: '🏃',
        streak: 0,
        energy_cost: 3,
        energy_return: 5,
        start_date: new Date('2024-07-01T00:00:00.000Z'),
        goals: [],
      };
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify([minimal]));

      const result = await loadHabits();
      expect(result).toHaveLength(1);
      expect(result![0]!.start_date).toBeInstanceOf(Date);
      expect(result![0]!.last_completion_date).toBeUndefined();
      expect(result![0]!.completions).toBeUndefined();
    });

    test('returns null on corrupted data', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

      const result = await loadHabits();
      expect(result).toBeNull();
    });

    test('self-heals a non-array payload by clearing the key', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify({ not: 'an array' }));

      const result = await loadHabits();
      expect(result).toBeNull();
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/habits');
    });

    test('keeps stored habits on a transient read error (does not delete)', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('SQLite hiccup'));

      const result = await loadHabits();
      expect(result).toBeNull();
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('clearHabits', () => {
    test('removes habits from AsyncStorage', async () => {
      await clearHabits();
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/habits');
    });
  });

  describe('loadPendingCheckIns', () => {
    test('returns an empty queue when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      const result = await loadPendingCheckIns();
      expect(result).toEqual([]);
    });

    test('returns the stored queue', async () => {
      const queue = [{ goal_id: 1, did_complete: true, timestamp: 't1' }];
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(queue));

      const result = await loadPendingCheckIns();
      expect(result).toEqual(queue);
    });

    test('self-heals corrupt JSON by clearing the key', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

      const result = await loadPendingCheckIns();
      expect(result).toEqual([]);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/pending_checkins');
    });

    test('self-heals a non-array payload by clearing the key', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify({ not: 'an array' }));

      const result = await loadPendingCheckIns();
      expect(result).toEqual([]);
      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/pending_checkins');
    });

    test('keeps the offline queue on a transient read error (does not delete)', async () => {
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('disk pressure'));

      const result = await loadPendingCheckIns();
      expect(result).toEqual([]);
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('savePendingCheckIn (serialized lane — BUG-FE-STORAGE-002)', () => {
    test('preserves every concurrent appender even when reads interleave with writes', async () => {
      // Simulate the AsyncStorage read/write semantics over a single
      // backing string. Without the serialized write lane, two
      // simultaneous appenders both call `getItem` first (each seeing
      // the same stale value) and the slower `setItem` clobbers the
      // faster one — silently losing one check-in.
      let storedRaw: string | null = null;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      mockAsyncStorage.getItem.mockImplementation(async (_key: string) => {
        await sleep(5);
        return storedRaw;
      });
      mockAsyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
        await sleep(5);
        storedRaw = value;
      });

      const checkIns = [
        { goal_id: 1, did_complete: true, timestamp: '2025-01-01T00:00:00Z' },
        { goal_id: 2, did_complete: true, timestamp: '2025-01-02T00:00:00Z' },
        { goal_id: 3, did_complete: true, timestamp: '2025-01-03T00:00:00Z' },
      ];
      await Promise.all(checkIns.map((c) => savePendingCheckIn(c)));

      const queue = await loadPendingCheckIns();
      expect(queue).toHaveLength(3);
      expect(queue.map((c) => c.goal_id).sort()).toEqual([1, 2, 3]);
    });

    test('replacePendingCheckIns also flows through the lane and overwrites the queue', async () => {
      let storedRaw: string | null = null;
      mockAsyncStorage.getItem.mockImplementation(async (_key: string) => storedRaw);
      mockAsyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
        storedRaw = value;
      });

      await savePendingCheckIn({ goal_id: 1, did_complete: true, timestamp: 't1' });
      await savePendingCheckIn({ goal_id: 2, did_complete: true, timestamp: 't2' });
      await replacePendingCheckIns([{ goal_id: 99, did_complete: false, timestamp: 't9' }]);

      const queue = await loadPendingCheckIns();
      expect(queue).toEqual([{ goal_id: 99, did_complete: false, timestamp: 't9' }]);
    });

    test('clearPendingCheckIns is linearised against an inflight save (review feedback)', async () => {
      // Models the resurrection race the reviewer flagged: a save
      // lambda already queued in the lane reads its existing items,
      // and only later finishes its setItem. If clearPendingCheckIns
      // ran outside the lane it could squeeze in BEFORE that setItem
      // and the save's writeback would re-create the data the clear
      // was supposed to drop.
      let storedRaw: string | null = null;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      mockAsyncStorage.getItem.mockImplementation(async (_key: string) => {
        await sleep(5);
        return storedRaw;
      });
      mockAsyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
        await sleep(5);
        storedRaw = value;
      });
      mockAsyncStorage.removeItem.mockImplementation(async (_key: string) => {
        await sleep(5);
        storedRaw = null;
      });

      // Issue a save and a clear back-to-back. With the lane, the save
      // commits, then the clear wipes the result, so the queue is empty.
      // Without the lane, the clear could land between the save's read
      // and write, and the save's writeback would resurrect the item.
      const savePromise = savePendingCheckIn({
        goal_id: 1,
        did_complete: true,
        timestamp: 't1',
      });
      const clearPromise = clearPendingCheckIns();
      await Promise.all([savePromise, clearPromise]);

      const queue = await loadPendingCheckIns();
      expect(queue).toEqual([]);
    });

    test('aborts the write and preserves the stored queue on a transient RMW read', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('transient read'));

      await expect(
        savePendingCheckIn({ goal_id: 2, did_complete: true, timestamp: 't2' }),
      ).resolves.toBeUndefined();

      expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    test('self-heals corrupt queue JSON inside the RMW then writes the single new check-in', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');
      const checkIn = { goal_id: 3, did_complete: true, timestamp: 't3' };

      await savePendingCheckIn(checkIn);

      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/pending_checkins');
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/pending_checkins',
        JSON.stringify([checkIn]),
      );

      warnSpy.mockRestore();
    });
  });
  describe('dropped check-in quarantine', () => {
    const DROPPED_KEY = '@adepthood/dropped_checkins';

    const dropped = (goalId: number, overrides: Partial<DroppedCheckIn> = {}): DroppedCheckIn => ({
      goal_id: goalId,
      did_complete: true,
      timestamp: '2025-05-01T00:00:00Z',
      status: 404,
      dropped_at: '2025-05-02T09:00:00Z',
      ...overrides,
    });

    const lastWritten = (): DroppedCheckIn[] => {
      const calls = mockAsyncStorage.setItem.mock.calls.filter((c) => c[0] === DROPPED_KEY);
      expect(calls.length).toBeGreaterThan(0);
      return JSON.parse(calls.at(-1)![1] as string) as DroppedCheckIn[];
    };

    beforeEach(() => {
      // A sibling test installs a stateful AsyncStorage double; restore the
      // file-level defaults so each case here starts from an empty store.
      mockAsyncStorage.getItem.mockImplementation(() => Promise.resolve(null));
      mockAsyncStorage.setItem.mockImplementation(() => Promise.resolve());
      mockAsyncStorage.removeItem.mockImplementation(() => Promise.resolve());
    });

    test('appends the first dropped check-in under the quarantine key', async () => {
      const entry = dropped(11);

      await recordDroppedCheckIn(entry);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockAsyncStorage.setItem.mock.calls[0]![0]).toBe(DROPPED_KEY);
      const written = lastWritten();
      expect(written).toHaveLength(1);
      expect(written[0]).toEqual(entry);
    });

    test('appends behind the entries already quarantined without losing them', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify([dropped(1), dropped(2)]));

      await recordDroppedCheckIn(dropped(3));

      const written = lastWritten();
      expect(written).toHaveLength(3);
      expect(written.map((d) => d.goal_id)).toEqual([1, 2, 3]);
    });

    test('bounds the quarantine at MAX_DROPPED_CHECK_INS, evicting the oldest', async () => {
      const seeded = Array.from({ length: MAX_DROPPED_CHECK_INS }, (_, i) => dropped(i + 1));
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(seeded));
      const newest = dropped(999);

      await recordDroppedCheckIn(newest);

      const written = lastWritten();
      expect(written).toHaveLength(MAX_DROPPED_CHECK_INS);
      expect(written[0]).toEqual(seeded[1]);
      expect(written.at(-1)).toEqual(newest);
    });

    test('aborts the write on a transient read rather than clobbering the quarantine', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('transient read'));

      await expect(recordDroppedCheckIn(dropped(5))).resolves.toBeUndefined();

      expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    test('resolves rather than rejecting when the quarantine write itself fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockAsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));

      await expect(recordDroppedCheckIn(dropped(6))).resolves.toBeUndefined();

      warnSpy.mockRestore();
    });

    test('serializes concurrent appends so neither drop record is lost', async () => {
      // Same read-modify-write race BUG-FE-STORAGE-002 covers for the pending
      // queue: without a serialized lane both appenders read the same stale
      // value and the slower write clobbers the faster one.
      let storedRaw: string | null = null;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      mockAsyncStorage.getItem.mockImplementation(async (_key: string) => {
        await sleep(5);
        return storedRaw;
      });
      mockAsyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
        await sleep(5);
        storedRaw = value;
      });

      const first = recordDroppedCheckIn(dropped(41));
      const second = recordDroppedCheckIn(dropped(42));
      await Promise.all([first, second]);

      const quarantined = await loadDroppedCheckIns();
      expect(quarantined).toHaveLength(2);
      expect(quarantined.map((d) => d.goal_id).sort((a, b) => a - b)).toEqual([41, 42]);
    });

    test('loadDroppedCheckIns returns an empty list when nothing is quarantined', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      await expect(loadDroppedCheckIns()).resolves.toEqual([]);
    });

    test('loadDroppedCheckIns returns the stored quarantine entries', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify([dropped(71), dropped(72)]));

      const result = await loadDroppedCheckIns();

      expect(result).toHaveLength(2);
      expect(result.map((d) => d.goal_id)).toEqual([71, 72]);
    });

    test('clearDroppedCheckIns removes the quarantine key', async () => {
      await clearDroppedCheckIns();

      expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(DROPPED_KEY);
    });
  });
});

/**
 * BUG-FE-STATE-001, defence in depth. The account-switch wipe in
 * ``AuthContext`` is the guarantee; this is the backstop for the day a future
 * sign-in path forgets to run it. Each account's rows live under their own
 * key, so the incoming session reads its own namespace rather than the
 * previous owner's.
 */
describe('habit caches are namespaced per account', () => {
  test('two accounts write their habits to different keys', async () => {
    setActiveUser(1);
    await saveHabits([sampleHabit]);
    const keyForUserOne = mockAsyncStorage.setItem.mock.calls[0]![0];

    setActiveUser(2);
    await saveHabits([sampleHabit]);
    const keyForUserTwo = mockAsyncStorage.setItem.mock.calls[1]![0];

    expect(keyForUserOne).not.toBe(keyForUserTwo);
  });

  test('a signed-in account never reads the unscoped legacy rows', async () => {
    setActiveUser(1);

    await loadHabits();

    expect(mockAsyncStorage.getItem).not.toHaveBeenCalledWith('@adepthood/habits');
  });

  test('the pending queue and its quarantine are namespaced too', async () => {
    setActiveUser(3);

    await clearPendingCheckIns();
    await clearDroppedCheckIns();

    const removed = mockAsyncStorage.removeItem.mock.calls.map(([key]) => key);
    expect(removed).not.toContain('@adepthood/pending_checkins');
    expect(removed).not.toContain('@adepthood/dropped_checkins');
    expect(removed).toHaveLength(2);
  });
});
