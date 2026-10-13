import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type * as ApiModule from '../../../../api';
import { ApiError, goalCompletions, habits } from '../../../../api';
import {
  capturePendingCheckInScope,
  loadDroppedCheckIns,
  loadPendingCheckIns,
  recordDroppedCheckIn,
  removePendingCheckIns,
  savePendingCheckIn,
} from '../../../../storage/habitStorage';
import type { PendingCheckIn } from '../../../../storage/habitStorage';
import { serialize } from '../../../../storage/serializedWrite';
import { setActiveUser } from '../../../../storage/userScope';
import { useHabitStore } from '../../../../store/useHabitStore';
import { HABIT_DEFAULTS } from '../../HabitDefaults';
import { habitManager } from '../habitManager';

const mockCheckInResult: Awaited<ReturnType<typeof goalCompletions.create>> = {
  streak: 1,
  milestones: [],
  reason_code: 'logged',
  day_units: 1,
};

jest.mock('../../../../api', () => ({
  ...jest.requireActual<typeof ApiModule>('../../../../api'),
  habits: { listAll: jest.fn(() => Promise.resolve([])) },
  goalCompletions: { create: jest.fn(() => Promise.resolve(mockCheckInResult)) },
}));

jest.mock('../../hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(() => Promise.resolve([])),
  cancelForHabit: jest.fn(() => Promise.resolve(undefined)),
}));

function deferred<T>() {
  let resolve!: (_value: T) => void;
  let reject!: (_reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const queued = (operationId: string, goalId = 1): PendingCheckIn => ({
  goal_id: goalId,
  did_complete: true,
  completed_units: 1,
  operation_id: operationId,
  timestamp: '2026-10-13T12:00:00Z',
});

beforeEach(async () => {
  await AsyncStorage.clear();
  setActiveUser(1);
  useHabitStore.setState({ habits: [], loading: false, error: null });
  jest.mocked(habits.listAll).mockResolvedValue([]);
  jest.mocked(goalCompletions.create).mockResolvedValue(mockCheckInResult);
});

afterEach(() => {
  setActiveUser(null);
  jest.restoreAllMocks();
});

describe('offline queue replay with concurrent writers (#3086)', () => {
  it.each(['success', 'transient failure'] as const)(
    'preserves an appended tap after a replay %s',
    async (outcome) => {
      const original = queued('original');
      const appended = queued('appended', 2);
      await savePendingCheckIn(original);
      const started = deferred<void>();
      const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
      jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });

      const replay = habitManager.loadHabits('UTC');
      await started.promise;
      await savePendingCheckIn(appended);
      if (outcome === 'success') response.resolve(mockCheckInResult);
      else response.reject(new Error('offline'));
      await replay;

      expect(await loadPendingCheckIns()).toEqual(
        outcome === 'success' ? [appended] : [original, appended],
      );
    },
  );

  it('shares one drain between overlapping loads', async () => {
    await savePendingCheckIn(queued('one'));
    const started = deferred<void>();
    const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
    jest.mocked(goalCompletions.create).mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const first = habitManager.loadHabits('UTC');
    await started.promise;
    const second = habitManager.loadHabits('UTC');
    // Let the second refresh reach the replay while the first POST is pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    response.resolve(mockCheckInResult);
    await Promise.all([first, second]);

    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
    expect(await loadPendingCheckIns()).toEqual([]);
  });

  it.each(['success', 'rejection'] as const)(
    'leaves both accounts intact when the owner switches during a %s',
    async (outcome) => {
      const first = queued('old-first');
      const second = queued('old-second', 2);
      const incoming = queued('new-account', 3);
      await savePendingCheckIn(first);
      await savePendingCheckIn(second);
      const started = deferred<void>();
      const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
      jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      const replay = habitManager.loadHabits('UTC');
      await started.promise;
      setActiveUser(2);
      await savePendingCheckIn(incoming);
      const incomingHabits = [
        {
          ...HABIT_DEFAULTS[0]!,
          id: 3,
          goals: [{ ...HABIT_DEFAULTS[0]!.goals[0]!, id: first.goal_id }],
          completions: [],
        },
      ];
      useHabitStore.setState({ habits: incomingHabits });
      if (outcome === 'success') response.resolve(mockCheckInResult);
      else response.reject(new ApiError(404, 'gone'));
      await replay;

      expect(await loadPendingCheckIns()).toEqual([incoming]);
      expect(await loadDroppedCheckIns()).toEqual([]);
      expect(goalCompletions.create).toHaveBeenCalledTimes(1);
      expect(useHabitStore.getState().habits).toEqual(incomingHabits);
      setActiveUser(1);
      expect(await loadPendingCheckIns()).toEqual([first, second]);
    },
  );

  it('quarantines an operation once even when it is reported concurrently', async () => {
    const entry = {
      ...queued('rejected'),
      status: 404,
      dropped_at: '2026-10-13T13:00:00Z',
    };
    await Promise.all([recordDroppedCheckIn(entry), recordDroppedCheckIn(entry)]);
    expect(await loadDroppedCheckIns()).toEqual([entry]);
  });

  it('removes only one matching legacy entry and preserves an identical later append', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-13T12:00:00Z' };
    await savePendingCheckIn(legacy);
    await savePendingCheckIn(legacy);
    await removePendingCheckIns([legacy], capturePendingCheckInScope());
    expect(await loadPendingCheckIns()).toEqual([legacy]);
  });

  it('refuses a cleanup waiting in the storage lane after the owner changes', async () => {
    const entry = queued('old');
    await savePendingCheckIn(entry);
    const blocked = deferred<void>();
    const holding = serialize('@adepthood/pending_checkins#u1', () => blocked.promise);
    const cleanup = removePendingCheckIns([entry], capturePendingCheckInScope());
    setActiveUser(2);
    const incoming = queued('incoming');
    await savePendingCheckIn(incoming);
    blocked.resolve();
    await Promise.all([holding, cleanup]);
    expect(await loadPendingCheckIns()).toEqual([incoming]);
    setActiveUser(1);
    expect(await loadPendingCheckIns()).toEqual([entry]);
  });
});
