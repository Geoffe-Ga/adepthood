import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { goalCompletions, habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import type { ApiHabit } from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { getActiveUser, setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), listAll: jest.fn() },
  goalCompletions: { create: jest.fn() },
}));
jest.mock('@/features/Habits/hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(async () => []),
  cancelForHabit: jest.fn(async () => {}),
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
function habit(id: number, name: string): Habit {
  return {
    id,
    name,
    stage: 'Beige',
    icon: '🧘',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    revealed: true,
    start_date: new Date('2026-10-01T00:00:00Z'),
    completions: [],
    goals: [
      {
        id: id * 10 + 1,
        title: 'Low',
        tier: 'low',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
      {
        id: id * 10 + 2,
        title: 'Clear',
        tier: 'clear',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
      {
        id: id * 10 + 3,
        title: 'Stretch',
        tier: 'stretch',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
    ],
  };
}
const outgoing = habit(101, 'Outgoing owner habit');
const incoming = habit(202, 'Incoming owner habit');
const tokenFor = (owner: number) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
async function adopt(owner: number, row: Habit): Promise<void> {
  setActiveUser(owner);
  setTokenGetter(() => tokenFor(owner));
  useHabitStore.getState().setHabits([row]);
  await saveHabits([row]);
}
async function snapshot() {
  return {
    memory: useHabitStore.getState().habits.map((row) => row.id),
    disk: (await loadHabits())?.map((row) => row.id),
  };
}
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.mocked(habits.create).mockReset();
  jest.mocked(habits.update).mockReset();
  jest.mocked(habits.delete).mockReset();
  jest.mocked(habits.listAll).mockReset();
  jest.mocked(goalCompletions.create).mockReset();
  jest.mocked(habits.update).mockResolvedValue({} as ApiHabit);
  jest.mocked(habits.delete).mockResolvedValue(undefined);
  jest.mocked(habits.listAll).mockResolvedValue([]);
  await adopt(1, outgoing);
});
afterEach(() => {
  setActiveUser(null);
  setTokenGetter(null);
});

it.each(['append', 'insert'])(
  'rejects mismatched initiating credentials before any %s mutation',
  async (kind) => {
    await adopt(2, incoming);
    setTokenGetter(() => tokenFor(1));
    jest.mocked(habits.create).mockRejectedValueOnce(new Error('must not send this request'));
    const changes: number[][] = [];
    const unsubscribe = useHabitStore.subscribe((state) =>
      changes.push(state.habits.map((row) => row.id)),
    );
    try {
      if (kind === 'append')
        await habitManager.addHabit({ name: 'New sitting', icon: '🧘' }, false, 'UTC');
      else await habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
      expect(habits.create).not.toHaveBeenCalled();
      expect(changes).toEqual([]);
      expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
    } finally {
      unsubscribe();
    }
  },
);

it.each(['no getter', 'null token', 'malformed token'])(
  'does not start an authenticated mutation with %s',
  async (credentialState) => {
    if (credentialState === 'no getter') setTokenGetter(null);
    else setTokenGetter(() => (credentialState === 'null token' ? null : 'not-a-jwt'));
    jest
      .mocked(habits.create)
      .mockRejectedValue(new Error('must not send an unauthenticated create'));
    const changes: number[][] = [];
    const unsubscribe = useHabitStore.subscribe((state) =>
      changes.push(state.habits.map((row) => row.id)),
    );
    try {
      await habitManager.addHabit({ name: 'New sitting', icon: '🧘' }, false, 'UTC');
      await habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
      expect({
        posts: jest.mocked(habits.create).mock.calls.length,
        contextWasRejected: habitManager.prepareLogUnit(outgoing.id, 1, 'UTC') === null,
        changes,
        state: await snapshot(),
      }).toEqual({
        posts: 0,
        contextWasRejected: true,
        changes: [],
        state: { memory: [101], disk: [101] },
      });
    } finally {
      unsubscribe();
    }
  },
);

it('preserves anonymous demo logging without a credential or server request', async () => {
  setActiveUser(null);
  setTokenGetter(null);
  const demo = { ...outgoing, isDemoSeed: true };
  useHabitStore.getState().setHabits([demo]);
  const ctx = habitManager.prepareLogUnit(demo.id, 1, 'UTC');
  expect(ctx).not.toBeNull();
  habitManager.applyLogUnitContext(ctx!);
  expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
  expect(await habitManager.commitLogUnitContext(ctx!)).toBeNull();
  expect(goalCompletions.create).not.toHaveBeenCalled();
  expect(habits.create).not.toHaveBeenCalled();
});

it.each(['append', 'insert'])(
  'does not revive an old %s failure after the original account returns',
  async (kind) => {
    const response = deferred<ApiHabit>();
    jest.mocked(habits.create).mockReturnValueOnce(response.promise);
    const saving =
      kind === 'append'
        ? habitManager.addHabit({ name: 'New sitting', icon: '🧘' }, false, 'UTC')
        : habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
    await adopt(2, incoming);
    await adopt(1, habit(303, 'Returned account fresh rows'));
    response.reject(new Error('controlled prior lifecycle failure'));
    await saving;
    expect(await snapshot()).toEqual({ memory: [303], disk: [303] });
  },
);

it('ignores a create-confirmation list response after the owner changes', async () => {
  jest.mocked(habits.create).mockResolvedValueOnce({ id: 333 } as ApiHabit);
  const listed = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
  const reading = deferred<void>();
  jest.mocked(habits.listAll).mockImplementationOnce(() => {
    reading.resolve();
    return listed.promise;
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await reading.promise;
  await adopt(2, incoming);
  listed.resolve([
    {
      id: 333,
      name: 'New sitting',
      stage: 'Beige',
      icon: '🧘',
      start_date: '2026-10-01',
      energy_cost: 1,
      energy_return: 1,
      revealed: true,
      goals: outgoing.goals,
    },
  ] as Awaited<ReturnType<typeof habits.listAll>>);
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('preserves the incoming owner store AND scoped disk when the outgoing create rejects', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  expect(habits.create).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner create failure'));
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
it('never issues outgoing sibling PUTs under the incoming owner after the create resolves', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const writes: unknown[] = [];
  jest.mocked(habits.update).mockImplementation(async (id) => {
    writes.push({ id, owner: getActiveUser() });
    return {} as ApiHabit;
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await adopt(2, incoming);
  response.resolve({ id: 333 } as ApiHabit);
  await saving;
  expect(writes).toEqual([]);
});
it('never compensates an outgoing create with DELETE under the incoming owner', async () => {
  jest.mocked(habits.create).mockResolvedValueOnce({ id: 333 } as ApiHabit);
  const started = deferred<void>();
  const placement = deferred<ApiHabit>();
  jest.mocked(habits.update).mockImplementationOnce(() => {
    started.resolve();
    return placement.promise;
  });
  const deletes: unknown[] = [];
  jest.mocked(habits.delete).mockImplementation(async (id) => {
    deletes.push({ id, owner: getActiveUser() });
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await started.promise;
  await adopt(2, incoming);
  placement.reject(new Error('controlled old-owner placement failure'));
  await saving;
  expect(deletes).toEqual([]);
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
it('a same-owner failed create still restores its own previous store and disk', async () => {
  jest.mocked(habits.create).mockRejectedValueOnce(new Error('controlled same-owner failure'));
  await habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  expect(await snapshot()).toEqual({ memory: [101], disk: [101] });
});

it('addHabit preserves the incoming owner store AND scoped disk on a late create rejection', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const saving = habitManager.addHabit({ name: 'New sitting', icon: '🧘' }, false, 'UTC');
  expect(habits.create).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner add failure'));
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('an existing delete rollback closure cannot restore outgoing rows into the incoming account', async () => {
  const response = deferred<void>();
  jest.mocked(habits.delete).mockReturnValueOnce(response.promise);
  habitManager.deleteHabit(outgoing.id);
  expect(habits.delete).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner delete failure'));
  await response.promise.catch(() => undefined);
  await Promise.resolve();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it.each(['apply', 'rollback', 'commit'])(
  'a prepared log context cannot %s after ownership changes',
  async (stage) => {
    const ctx = habitManager.prepareLogUnit(outgoing.id, 1, 'UTC');
    expect(ctx).not.toBeNull();
    habitManager.applyLogUnitContext(ctx!);
    await adopt(2, incoming);
    if (stage === 'apply') habitManager.applyLogUnitContext(ctx!);
    if (stage === 'rollback') habitManager.rollbackLogUnitContext(ctx!);
    if (stage === 'commit') await habitManager.commitLogUnitContext(ctx!);
    expect(goalCompletions.create).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
  },
);

it('an old log response cannot overwrite a fresh lifecycle of the original account', async () => {
  const ctx = habitManager.prepareLogUnit(outgoing.id, 1, 'UTC')!;
  habitManager.applyLogUnitContext(ctx);
  await adopt(2, incoming);
  const fresh = habit(outgoing.id, 'Returned account confirmed nine');
  fresh.completions = [{ id: 'confirmed-return', timestamp: new Date(), completed_units: 9 }];
  await adopt(1, fresh);
  habitManager.reconcileLogUnitContext(ctx, {
    streak: 1,
    day_units: 1,
    milestones: [],
    reason_code: 'units_adjusted',
  });
  expect(useHabitStore.getState().habits).toEqual([fresh]);
  expect(await loadHabits()).toEqual([fresh]);
});

it('keeps the initiating credential for a same-owner successful create and every follow-on request', async () => {
  const created = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(created.promise);
  jest.mocked(habits.listAll).mockResolvedValueOnce([
    {
      id: 333,
      name: 'New sitting',
      stage: 'Beige',
      icon: '🧘',
      start_date: '2026-10-01',
      energy_cost: 1,
      energy_return: 1,
      revealed: true,
      goals: outgoing.goals,
    },
  ] as Awaited<ReturnType<typeof habits.listAll>>);
  const credential = tokenFor(1);
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  setTokenGetter(() => `e30.${btoa(JSON.stringify({ sub: '1', exp: 4_000_000_001 }))}.sig`);
  created.resolve({ id: 333 } as ApiHabit);
  expect(await saving).toEqual({ kept: true, habitId: 333 });
  expect(jest.mocked(habits.create).mock.calls[0]?.[1]).toBe(credential);
  expect(jest.mocked(habits.update).mock.calls[0]?.[2]).toBe(credential);
  expect(jest.mocked(habits.listAll).mock.calls[0]?.[0]).toBe(credential);
  expect(await snapshot()).toEqual({ memory: [333], disk: [333] });
});

it('does not roll back into the incoming account when an already sent compensation resolves', async () => {
  jest.mocked(habits.create).mockResolvedValueOnce({ id: 333 } as ApiHabit);
  jest.mocked(habits.update).mockRejectedValueOnce(new Error('placement failed'));
  const removed = deferred<void>();
  const deleting = deferred<void>();
  jest.mocked(habits.delete).mockImplementationOnce(() => {
    deleting.resolve();
    return removed.promise;
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await deleting.promise;
  expect(jest.mocked(habits.delete).mock.calls[0]?.[1]).toBe(tokenFor(1));
  await adopt(2, incoming);
  removed.resolve();
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('does not send an outgoing log that waited in the habit-day queue across an account change', async () => {
  const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
  const posted = deferred<void>();
  jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
    posted.resolve();
    return response.promise;
  });
  const first = habitManager.prepareLogUnit(outgoing.id, 1, 'UTC')!;
  habitManager.applyLogUnitContext(first);
  const committingFirst = habitManager.commitLogUnitContext(first);
  await posted.promise;
  const second = habitManager.prepareLogUnit(outgoing.id, 1, 'UTC')!;
  habitManager.applyLogUnitContext(second);
  const committingSecond = habitManager.commitLogUnitContext(second);
  await adopt(2, incoming);
  response.resolve({ streak: 1, day_units: 1, milestones: [], reason_code: 'units_adjusted' });
  await committingFirst;
  expect(await committingSecond).toBeNull();
  expect(goalCompletions.create).toHaveBeenCalledTimes(1);
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
