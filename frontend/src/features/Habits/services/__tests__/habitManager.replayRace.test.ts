import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type * as ApiModule from '../../../../api';
import { ApiError, goalCompletions, habits, setTokenGetter } from '../../../../api';
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
import { setUserTimezonePending } from '../../../../storage/userCalendar';
import {
  beginActiveUserTransition,
  getActiveUser,
  setActiveUser,
} from '../../../../storage/userScope';
import { useDroppedCheckInStore } from '../../../../store/useDroppedCheckInStore';
import { useHabitStore } from '../../../../store/useHabitStore';
import { HABIT_DEFAULTS } from '../../HabitDefaults';
import { habitManager } from '../habitManager';

const mockCheckInResult: Awaited<ReturnType<typeof goalCompletions.create>> = {
  streak: 1,
  milestones: [],
  reason_code: 'logged',
  day_units: 1,
};
const mockStorageRead = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;

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

const tokenFor = (owner: number) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;

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
  setTokenGetter(() => tokenFor(getActiveUser() ?? 1));
  setUserTimezonePending(1, false);
  useHabitStore.setState({ habits: [], loading: false, error: null });
  jest.mocked(habits.listAll).mockResolvedValue([]);
  jest.mocked(goalCompletions.create).mockResolvedValue(mockCheckInResult);
});

afterEach(() => {
  setActiveUser(null);
  setTokenGetter(null);
  jest.restoreAllMocks();
  jest.mocked(AsyncStorage.getItem).mockImplementation(mockStorageRead);
  setUserTimezonePending(1, false);
});

describe('offline queue replay with concurrent writers (#3086)', () => {
  it('keeps an identical later legacy append when the identified original finishes', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
    await savePendingCheckIn(legacy);
    const started = deferred<void>();
    const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
    jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const replay = habitManager.loadHabits('UTC');
    await started.promise;
    expect((await loadPendingCheckIns())[0]?.replay_id).toEqual(expect.any(String));
    await savePendingCheckIn(legacy);
    response.resolve(mockCheckInResult);
    await replay;
    expect(await loadPendingCheckIns()).toEqual([legacy]);
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
  });

  it('does not stamp identities after a queued storage lane changes owners', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
    await savePendingCheckIn(legacy);
    const blocked = deferred<void>();
    const holding = serialize('@adepthood/pending_checkins#u1', () => blocked.promise);
    const preparing = loadPendingCheckIns(capturePendingCheckInScope(), true);
    setActiveUser(2);
    const incoming = queued('new-owner');
    await savePendingCheckIn(incoming);
    blocked.resolve();
    await holding;
    expect(await preparing).toEqual([]);
    expect(await loadPendingCheckIns()).toEqual([incoming]);
    setActiveUser(1);
    expect(await loadPendingCheckIns()).toEqual([legacy]);
  });

  it('retains two identical legacy taps as separate losses', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
    await Promise.all([savePendingCheckIn(legacy), savePendingCheckIn(legacy)]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(goalCompletions.create).mockRejectedValue(new ApiError(404, 'goal_not_found'));
    await Promise.all([habitManager.loadHabits('UTC'), habitManager.loadHabits('UTC')]);
    const dropped = await loadDroppedCheckIns();
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.replay_id).toEqual(expect.any(String));
    expect(dropped[0]?.replay_id).not.toBe(dropped[1]?.replay_id);
    expect(goalCompletions.create).toHaveBeenCalledTimes(2);
    expect(await loadPendingCheckIns()).toEqual([]);
  });

  it('defers legacy replay when its identity cannot be persisted', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
    await savePendingCheckIn(legacy);
    const write = jest.spyOn(AsyncStorage, 'setItem');
    const original = write.getMockImplementation()!;
    write.mockImplementation((key, value) =>
      key === '@adepthood/pending_checkins#u1'
        ? Promise.reject(new Error('temporary identity write failure'))
        : original(key, value),
    );
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await habitManager.loadHabits('UTC');
    expect(goalCompletions.create).not.toHaveBeenCalled();
    expect(await loadPendingCheckIns()).toEqual([legacy]);
    write.mockImplementation(original);
    await habitManager.loadHabits('UTC');
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
  });

  it('quarantines a legacy rejection once across cleanup failure and repeated loads (#3184)', async () => {
    const legacy = { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
    await savePendingCheckIn(legacy);
    await recordDroppedCheckIn({
      ...queued('unrelated'),
      status: 404,
      dropped_at: '2026-10-12T13:00:00Z',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const read = jest.spyOn(AsyncStorage, 'getItem');
    jest.mocked(goalCompletions.create).mockImplementation(async () => {
      // The quarantine read succeeds; pending cleanup fails afterward.
      let rejected = false;
      read.mockImplementation((key) => {
        if (key === '@adepthood/pending_checkins#u1' && !rejected) {
          rejected = true;
          return Promise.reject(new Error('temporary cleanup failure'));
        }
        return mockStorageRead(key);
      });
      throw new ApiError(404, 'goal_not_found');
    });
    for (let attempt = 0; attempt < 25; attempt += 1) await habitManager.loadHabits('UTC');
    const dropped = await loadDroppedCheckIns();
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.operation_id).toBe('unrelated');
    expect(useDroppedCheckInStore.getState().entries).toHaveLength(2);
    expect(await loadPendingCheckIns()).toHaveLength(1);
    expect(
      jest
        .mocked(goalCompletions.create)
        .mock.calls.every(
          ([, options]) => options?.token === tokenFor(1) && options.idempotencyKey === undefined,
        ),
    ).toBe(true);
  });

  it('still hydrates the saved quarantine notice while replay waits for a confirmed calendar', async () => {
    const entry = {
      ...queued('previously-rejected'),
      status: 404,
      dropped_at: '2026-10-13T13:00:00Z',
    };
    await recordDroppedCheckIn(entry);
    useDroppedCheckInStore.getState().setEntries([]);
    setUserTimezonePending(1, true);
    await habitManager.loadHabits('UTC', { replayCheckIns: false });
    expect(useDroppedCheckInStore.getState().entries).toEqual([entry]);
    expect(goalCompletions.create).not.toHaveBeenCalled();
  });

  it('defers every refresh caller while auth marks the calendar provisional', async () => {
    const entry = { ...queued('journal-bootstrap'), timestamp: '2026-10-12T01:00:00Z' };
    await savePendingCheckIn(entry);
    setUserTimezonePending(1, true);
    await habitManager.loadHabits('UTC');
    expect(goalCompletions.create).not.toHaveBeenCalled();
    expect(await loadPendingCheckIns()).toEqual([entry]);
    setUserTimezonePending(1, false);
    await habitManager.loadHabits('America/Los_Angeles');
    expect(goalCompletions.create).toHaveBeenCalledWith(
      expect.objectContaining({ completed_on: '2026-10-11' }),
      expect.anything(),
    );
  });

  it.each(['signed units', 'legacy amount-less'])(
    'retains an accepted %s operation when cleanup storage is temporarily unreadable',
    async (kind) => {
      const entry: PendingCheckIn =
        kind === 'signed units'
          ? queued('accepted-before-read-failure')
          : { goal_id: 1, did_complete: true, timestamp: '2026-10-12T12:00:00Z' };
      await savePendingCheckIn(entry);
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const read = jest.spyOn(AsyncStorage, 'getItem');
      jest.mocked(goalCompletions.create).mockImplementationOnce(async () => {
        read.mockRejectedValueOnce(new Error('storage temporarily unavailable'));
        return mockCheckInResult;
      });

      await expect(habitManager.loadHabits('UTC')).resolves.toBeUndefined();
      expect(await loadPendingCheckIns()).toEqual([expect.objectContaining({ ...entry })]);
      if (kind === 'legacy amount-less') {
        expect((await loadPendingCheckIns())[0]?.replay_id).toEqual(expect.any(String));
      }
      await habitManager.loadHabits('UTC');
      expect(await loadPendingCheckIns()).toEqual([]);
      const calls = jest.mocked(goalCompletions.create).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
      if (kind === 'signed units') {
        expect(calls[0]![1]).toEqual({
          token: tokenFor(1),
          idempotencyKey: `log-unit:${entry.operation_id}`,
        });
      } else {
        // Amount-less writes are naturally idempotent on (user, goal, day):
        // backend/tests/test_goal_completions.py::test_same_day_completion_is_idempotent.
        expect(calls[0]![0]).toEqual({
          goal_id: 1,
          did_complete: true,
          completed_on: '2026-10-12',
        });
      }
    },
  );

  it('does not post queued timestamps while the bootstrap timezone is provisional', async () => {
    const entry = { ...queued('waiting-for-zone'), timestamp: '2026-10-12T01:00:00Z' };
    await savePendingCheckIn(entry);
    await habitManager.loadHabits('UTC', { replayCheckIns: false });
    expect(goalCompletions.create).not.toHaveBeenCalled();
    expect(await loadPendingCheckIns()).toEqual([entry]);

    await habitManager.loadHabits('America/Los_Angeles');
    expect(goalCompletions.create).toHaveBeenCalledWith(
      expect.objectContaining({ completed_on: '2026-10-11' }),
      expect.anything(),
    );
  });

  it('uses the latest authoritative zone before a pending queue read reaches the POST', async () => {
    await savePendingCheckIn({ ...queued('hydrated-zone'), timestamp: '2026-10-12T01:00:00Z' });
    const started = deferred<void>();
    const response = deferred<string | null>();
    const originalRead = mockStorageRead;
    let held = false;
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key) => {
      if (key === '@adepthood/pending_checkins#u1' && !held) {
        held = true;
        started.resolve();
        return response.promise;
      }
      return originalRead(key);
    });
    const first = habitManager.loadHabits('UTC');
    await started.promise;
    const second = habitManager.loadHabits('America/Los_Angeles');
    await new Promise<void>((resolve) => setImmediate(resolve));
    response.resolve(await originalRead('@adepthood/pending_checkins#u1'));
    await Promise.all([first, second]);
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
    expect(goalCompletions.create).toHaveBeenCalledWith(
      expect.objectContaining({ completed_on: '2026-10-11' }),
      expect.anything(),
    );
  });

  it('does not let an older refresh finishing late overwrite the latest replay calendar', async () => {
    await savePendingCheckIn({ ...queued('late-refresh'), timestamp: '2026-10-12T01:00:00Z' });
    const firstFetchStarted = deferred<void>();
    const firstFetch = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
    jest.mocked(habits.listAll).mockImplementationOnce(() => {
      firstFetchStarted.resolve();
      return firstFetch.promise;
    });
    const queueStarted = deferred<void>();
    const queueRead = deferred<string | null>();
    let held = false;
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key) => {
      if (key === '@adepthood/pending_checkins#u1' && !held) {
        held = true;
        queueStarted.resolve();
        return queueRead.promise;
      }
      return mockStorageRead(key);
    });
    const first = habitManager.loadHabits('UTC');
    await firstFetchStarted.promise;
    const second = habitManager.loadHabits('America/Los_Angeles');
    await queueStarted.promise;
    firstFetch.resolve([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    queueRead.resolve(await mockStorageRead('@adepthood/pending_checkins#u1'));
    await Promise.all([first, second]);
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
    expect(goalCompletions.create).toHaveBeenCalledWith(
      expect.objectContaining({ completed_on: '2026-10-11' }),
      expect.anything(),
    );
  });

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

  it('serializes a fresh same-owner drain behind its stale in-flight drain', async () => {
    const entry = queued('owner-one-returned');
    await savePendingCheckIn(entry);
    const started = deferred<void>();
    const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
    jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });

    const originalDrain = habitManager.loadHabits('UTC');
    await started.promise;
    setActiveUser(2);
    setActiveUser(1);
    const returnedOwnerDrain = habitManager.loadHabits('America/Los_Angeles');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The returning session must not race the old request, even though the
    // old session's scope can no longer settle owner one's queue.
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
    response.resolve(mockCheckInResult);
    await Promise.all([originalDrain, returnedOwnerDrain]);

    expect(goalCompletions.create).toHaveBeenCalledTimes(2);
    expect(await loadPendingCheckIns()).toEqual([]);
  });

  it('keeps every account queue while logout invalidates one same-owner drain', async () => {
    const first = queued('owner-one-first');
    const second = queued('owner-one-second', 2);
    await savePendingCheckIn(first);
    await savePendingCheckIn(second);
    const started = deferred<void>();
    const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
    jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });

    const originalDrain = habitManager.loadHabits('UTC');
    await started.promise;
    const overlappingLoad = habitManager.loadHabits('America/Los_Angeles');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(goalCompletions.create).toHaveBeenCalledTimes(1);

    setActiveUser(2);
    const ownerTwo = queued('owner-two', 3);
    await savePendingCheckIn(ownerTwo);
    setActiveUser(3);
    const ownerThree = queued('owner-three', 4);
    await savePendingCheckIn(ownerThree);
    beginActiveUserTransition();
    setActiveUser(null);
    response.resolve(mockCheckInResult);
    await Promise.all([originalDrain, overlappingLoad]);

    expect(goalCompletions.create).toHaveBeenCalledTimes(1);
    setActiveUser(1);
    expect(await loadPendingCheckIns()).toEqual([first, second]);
    setActiveUser(2);
    expect(await loadPendingCheckIns()).toEqual([ownerTwo]);
    setActiveUser(3);
    expect(await loadPendingCheckIns()).toEqual([ownerThree]);
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
