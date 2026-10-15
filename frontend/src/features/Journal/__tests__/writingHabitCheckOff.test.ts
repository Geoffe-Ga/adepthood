/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockCreate = jest.fn<(..._args: unknown[]) => Promise<unknown>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, goalCompletions: { create: (...args: unknown[]) => mockCreate(...args) } };
});

import { loggedToast } from '../saveAsHabitCopy';
import {
  MIN_CHECK_OFF_ELAPSED_MS,
  checkOffLinkedHabit,
  isLinkableHabit,
} from '../writingHabitCheckOff';
import { toWritingSessionResult } from '../writingSession';

import { setTokenGetter } from '@/api';
import type { ToastConfig } from '@/components/Toast';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

const OWNER_TOKEN = `e30.${btoa(JSON.stringify({ sub: '1', exp: 4_000_000_000 }))}.sig`;
const TZ = 'UTC';
const HABIT_ID = 42;
const LOW_TARGET = 10;
const ELAPSED_MS = 10 * 60_000;
const RESULT = toWritingSessionResult({ plannedMinutes: 20, elapsedMs: ELAPSED_MS });
const NOW = new Date('2026-09-27T09:30:00Z');
const SERVER_DAY_UNITS = LOW_TARGET;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 101 : tier === 'clear' ? 102 : 103,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? LOW_TARGET : tier === 'clear' ? 20 : 45,
  target_unit: 'minutes',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Morning pages',
  icon: '✍️',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

const SERVER_READ = async (): Promise<boolean> => true;

const withTodayUnits = (units: number): Habit =>
  makeHabit({ completions: [{ id: 't-1', timestamp: new Date(), completed_units: units }] });

const serverResult = (dayUnits = SERVER_DAY_UNITS) => ({
  streak: 1,
  milestones: [],
  reason_code: 'units_adjusted',
  day_units: dayUnits,
});

let showToast: jest.Mock<(_config: ToastConfig) => void>;

const run = (overrides: Partial<Parameters<typeof checkOffLinkedHabit>[0]> = {}) =>
  checkOffLinkedHabit({
    habitId: HABIT_ID,
    result: RESULT,
    tz: TZ,
    showToast,
    now: () => NOW,
    ...overrides,
  });

beforeEach(() => {
  setActiveUser(1);
  setTokenGetter(() => OWNER_TOKEN);
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(serverResult());
  showToast = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  useHabitStore.getState().setHabits([makeHabit()]);
  // The server agrees with the store unless a test says otherwise.
  jest.spyOn(habitManager, 'refreshHabits').mockImplementation(SERVER_READ);
});

afterEach(() => {
  setActiveUser(null);
  setTokenGetter(null);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('isLinkableHabit', () => {
  it('admits an additive, server-backed habit with all three tiers', () => {
    expect(isLinkableHabit(makeHabit())).toBe(true);
  });

  it('refuses a subtractive habit: checking one off would record consumption', () => {
    const goals = (['low', 'clear', 'stretch'] as const).map((tier) =>
      makeGoal(tier, { is_additive: false }),
    );
    expect(isLinkableHabit(makeHabit({ goals }))).toBe(false);
  });

  it('refuses a locked habit: nothing can be logged against one until it is open', () => {
    expect(isLinkableHabit(makeHabit({ revealed: false }))).toBe(false);
    expect(isLinkableHabit(makeHabit({ revealed: undefined }))).toBe(false);
  });

  it('refuses a demo tile, whose ids name no server row', () => {
    expect(isLinkableHabit(makeHabit({ isDemoSeed: true }))).toBe(false);
  });

  it('refuses a habit whose ids this device minted', () => {
    expect(isLinkableHabit(makeHabit({ hasClientMintedIds: true }))).toBe(false);
  });

  it('refuses a habit still holding a pre-sync placeholder id', () => {
    expect(isLinkableHabit(makeHabit({ id: -1 }))).toBe(false);
  });

  it('refuses a habit without the three-tier ladder', () => {
    expect(isLinkableHabit(makeHabit({ goals: [makeGoal('low'), makeGoal('clear')] }))).toBe(false);
  });
});

describe('checkOffLinkedHabit', () => {
  it('posts the measured minutes through the logUnit pipeline, dated now, and says so', async () => {
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');
    const reconcile = jest.spyOn(habitManager, 'reconcileReservedLogUnitContext');

    await run();

    expect(prepare).toHaveBeenCalledWith(HABIT_ID, LOW_TARGET, TZ, NOW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [payload, options] = mockCreate.mock.calls[0] as [
      Record<string, unknown>,
      { idempotencyKey?: string },
    ];
    expect(payload).toEqual({
      goal_id: 101,
      did_complete: true,
      completed_on: undefined,
      completed_units: 10,
      via_timer: true,
    });
    expect(options.idempotencyKey).toMatch(/^log-unit:/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0].message).toBe(loggedToast(10, 'minutes', 'Morning pages'));
  });

  it('a second session on the same day adds ten more measured minutes', async () => {
    await run();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    await run();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ completed_units: 10 }));
  });

  it('a zero-length session checks nothing off', async () => {
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');

    await run({ result: toWritingSessionResult({ plannedMinutes: 20, elapsedMs: 0 }) });

    expect(prepare).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the shortest session that ran at all does check off', async () => {
    await run({
      result: toWritingSessionResult({ plannedMinutes: 20, elapsedMs: MIN_CHECK_OFF_ELAPSED_MS }),
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('loads the habits first when the linked one is not in the store', async () => {
    useHabitStore.getState().setHabits([]);
    const load = jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([makeHabit()]);
      return true;
    });

    await run();

    expect(load).toHaveBeenCalledWith(TZ);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a linked habit that no longer exists posts nothing and throws nothing', async () => {
    useHabitStore.getState().setHabits([]);
    jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(true);

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a habit that stopped being linkable (now subtractive) posts nothing', async () => {
    const goals = (['low', 'clear', 'stretch'] as const).map((tier) =>
      makeGoal(tier, { is_additive: false }),
    );
    useHabitStore.getState().setHabits([makeHabit({ goals })]);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a linked habit that is locked again goes quiet: no post and no toast', async () => {
    useHabitStore.getState().setHabits([makeHabit({ revealed: false })]);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reads current server eligibility but still adds this session after another device logged', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([withTodayUnits(LOW_TARGET)]);
      return true;
    });

    await run();

    expect(habitManager.refreshHabits).toHaveBeenCalledWith(TZ);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ completed_units: 10, via_timer: true }),
      expect.anything(),
    );
  });

  it('posts all measured minutes when the server already has partial progress', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([withTodayUnits(1)]);
      return true;
    });

    await run();

    const [payload] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(payload.completed_units).toBe(10);
  });

  it('posts nothing when the server’s day cannot be read', async () => {
    // The cache keeps the list on screen, so only the read's own answer says
    // this day is stale.
    jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(false);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not post after ownership changes while refreshing the habit', async () => {
    let finish: ((_fresh: boolean) => void) | undefined;
    jest.mocked(habitManager.refreshHabits).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = run();
    setActiveUser(2);
    finish!(true);
    await pending;
    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not reconcile, rollback, or show an old account’s result after its post returns', async () => {
    let finish: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let posted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      posted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          posted!();
        }),
    );
    const rollback = jest.spyOn(habitManager, 'rollbackLogUnitContext');
    const reconcile = jest.spyOn(habitManager, 'reconcileLogUnitContext');
    const pending = run();
    await ready;
    setActiveUser(2);
    const incoming = [makeHabit({ name: 'Incoming account' })];
    useHabitStore.setState({ habits: incoming });
    finish!(serverResult());
    await pending;
    expect(useHabitStore.getState().habits).toEqual(incoming);
    expect(rollback).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not revive an old log when the account changes away and back', async () => {
    let finish: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let posted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      posted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          posted!();
        }),
    );
    const pending = run();
    await ready;
    setActiveUser(2);
    setActiveUser(1);
    const incoming = [makeHabit({ name: 'Rehydrated account' })];
    useHabitStore.getState().setHabits(incoming);
    finish!(serverResult());
    await pending;
    expect(useHabitStore.getState().habits).toEqual(incoming);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a failed post preserves confirmed state without snapshot rollback and shows nothing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('offline'));
    const rollback = jest.spyOn(habitManager, 'rollbackLogUnitContext');
    const before = useHabitStore.getState().habits;

    await expect(run()).resolves.toBeUndefined();

    expect(rollback).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toEqual(before);
    expect(console.warn).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a commit that resolves no result shows no toast', async () => {
    jest.spyOn(habitManager, 'commitLogUnitContext').mockResolvedValueOnce(null);
    const reconcile = jest.spyOn(habitManager, 'reconcileLogUnitContext');

    await run();

    expect(reconcile).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a changed link cancels queued minutes without leaving them in memory or on disk', async () => {
    let finishFirst: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let firstPosted: (() => void) | undefined;
    const posted = new Promise<void>((resolve) => {
      firstPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
          firstPosted!();
        }),
    );
    const originalCommit = habitManager.commitLogUnitContext;
    let secondQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      secondQueued = resolve;
    });
    let commits = 0;
    jest.spyOn(habitManager, 'commitLogUnitContext').mockImplementation((ctx, options) => {
      const pending = originalCommit(ctx, options);
      if (++commits === 2) secondQueued!();
      return pending;
    });
    let sameLink = true;
    const first = run({ isCurrent: () => sameLink });
    await posted;
    const second = run({
      result: toWritingSessionResult({ plannedMinutes: 20, elapsedMs: 20 * 60_000 }),
      isCurrent: () => sameLink,
    });
    await queued;
    sameLink = false;
    finishFirst!(serverResult(10));
    await Promise.all([first, second]);
    const amount = (habits: Habit[]) =>
      habits
        .find((habit) => habit.id === HABIT_ID)!
        .completions!.reduce((total, completion) => total + completion.completed_units, 0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect({
      memory: amount(useHabitStore.getState().habits),
      disk: amount((await loadHabits())!),
    }).toEqual({ memory: 10, disk: 10 });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a rejected timed log preserves another habit’s confirmed update in memory and on disk', async () => {
    const otherId = 43;
    useHabitStore
      .getState()
      .setHabits([makeHabit(), makeHabit({ id: otherId, name: 'Reading', icon: '📖' })]);
    let rejectTimed: ((_error: Error) => void) | undefined;
    let timedPosted: (() => void) | undefined;
    const posted = new Promise<void>((resolve) => {
      timedPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTimed = reject;
          timedPosted!();
        }),
    );
    const pending = run();
    await posted;
    const otherContext = habitManager.prepareLogUnit(otherId, 7, TZ, NOW)!;
    habitManager.applyLogUnitContext(otherContext);
    const response = await habitManager.commitLogUnitContext(otherContext);
    habitManager.reconcileLogUnitContext(otherContext, response!);
    const confirmedOther = useHabitStore.getState().habits.find((habit) => habit.id === otherId)!;
    rejectTimed!(new Error('offline'));
    await pending;
    expect(useHabitStore.getState().habits.find((habit) => habit.id === otherId)).toEqual(
      confirmedOther,
    );
    expect((await loadHabits())!.find((habit) => habit.id === otherId)).toEqual(confirmedOther);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a pending or canceled timed log never changes confirmed metadata or persists a completion', async () => {
    const baseline = makeHabit({
      streak: 7,
      last_completion_date: new Date('2026-09-26T09:30:00Z'),
    });
    useHabitStore.getState().setHabits([baseline]);
    await saveHabits([baseline]);
    let rejectTimed: ((_error: Error) => void) | undefined;
    let timedPosted: (() => void) | undefined;
    const posted = new Promise<void>((resolve) => {
      timedPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTimed = reject;
          timedPosted!();
        }),
    );
    const pending = run();
    await posted;
    const whilePending = useHabitStore.getState().habits;
    const diskWhilePending = await loadHabits();
    rejectTimed!(new Error('offline'));
    await pending;
    expect(whilePending).toEqual([baseline]);
    expect(diskWhilePending).toEqual([baseline]);
    expect(useHabitStore.getState().habits).toEqual([baseline]);
    expect((await loadHabits())!).toEqual([baseline]);
  });

  it('a quiet timer confirmation preserves a later regular optimistic log on the same habit', async () => {
    const responses: Array<(_result: ReturnType<typeof serverResult>) => void> = [];
    const ready: Array<() => void> = [];
    const firstPosted = new Promise<void>((resolve) => {
      ready.push(resolve);
    });
    const secondPosted = new Promise<void>((resolve) => {
      ready.push(resolve);
    });
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          responses.push(resolve);
          ready[responses.length - 1]!();
        }),
    );
    const timed = run();
    await firstPosted;
    const regularContext = habitManager.prepareLogUnit(HABIT_ID, 3, TZ, NOW)!;
    habitManager.applyLogUnitContext(regularContext);
    const regular = habitManager.commitLogUnitContext(regularContext);
    responses[0]!(serverResult(10));
    await secondPosted;
    await timed;
    const total = () =>
      useHabitStore
        .getState()
        .habits[0]!.completions!.reduce((sum, completion) => sum + completion.completed_units, 0);
    expect(total()).toBe(13);
    responses[1]!(serverResult(13));
    habitManager.reconcileLogUnitContext(regularContext, (await regular)!);
    expect(total()).toBe(13);
    expect(
      (await loadHabits())![0]!.completions!.reduce(
        (sum, completion) => sum + completion.completed_units,
        0,
      ),
    ).toBe(13);
  });

  it('two queued timed logs canceled behind a regular log leave only its confirmed amount', async () => {
    let finishFirst: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let firstPosted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      firstPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
          firstPosted!();
        }),
    );
    const regularContext = habitManager.prepareLogUnit(HABIT_ID, 1, TZ, NOW)!;
    habitManager.applyLogUnitContext(regularContext);
    const regular = habitManager.commitLogUnitContext(regularContext);
    await ready;
    const commit = habitManager.commitLogUnitContext;
    let queuedCount = 0;
    let allQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      allQueued = resolve;
    });
    jest.spyOn(habitManager, 'commitLogUnitContext').mockImplementation((ctx, options) => {
      const pending = commit(ctx, options);
      if (++queuedCount === 2) allQueued!();
      return pending;
    });
    let sameLink = true;
    const first = run({ isCurrent: () => sameLink });
    const second = run({ isCurrent: () => sameLink });
    await queued;
    sameLink = false;
    finishFirst!(serverResult(1));
    habitManager.reconcileLogUnitContext(regularContext, (await regular)!);
    await Promise.all([first, second]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const confirmed = useHabitStore.getState().habits[0]!;
    expect(
      confirmed.completions!.reduce((sum, completion) => sum + completion.completed_units, 0),
    ).toBe(1);
    expect(confirmed.streak).toBe(1);
    expect((await loadHabits())![0]).toEqual(confirmed);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a later regular log failure preserves an already confirmed quiet timer log', async () => {
    let finishTimed: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let timedPosted: (() => void) | undefined;
    const posted = new Promise<void>((resolve) => {
      timedPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTimed = resolve;
          timedPosted!();
        }),
    );
    mockCreate.mockRejectedValueOnce(new Error('regular log failed'));
    const timed = run();
    await posted;
    const regularContext = habitManager.prepareLogUnit(HABIT_ID, 3, TZ, NOW)!;
    habitManager.applyLogUnitContext(regularContext);
    const regular = habitManager.commitLogUnitContext(regularContext).catch(() => {
      habitManager.rollbackLogUnitContext(regularContext);
    });
    finishTimed!(serverResult(10));
    await Promise.all([timed, regular]);
    const confirmed = useHabitStore.getState().habits[0]!;
    expect(
      confirmed.completions!.reduce((sum, completion) => sum + completion.completed_units, 0),
    ).toBe(10);
    expect((await loadHabits())![0]).toEqual(confirmed);
  });

  it('another habit’s older pending rollback preserves a newly confirmed quiet timer log', async () => {
    const otherId = 43;
    useHabitStore.getState().setHabits([makeHabit(), makeHabit({ id: otherId, name: 'Reading' })]);
    let rejectOther: ((_error: Error) => void) | undefined;
    let otherPosted: (() => void) | undefined;
    const posted = new Promise<void>((resolve) => {
      otherPosted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOther = reject;
          otherPosted!();
        }),
    );
    const otherContext = habitManager.prepareLogUnit(otherId, 3, TZ, NOW)!;
    habitManager.applyLogUnitContext(otherContext);
    const other = habitManager.commitLogUnitContext(otherContext).catch(() => {
      habitManager.rollbackLogUnitContext(otherContext);
    });
    await posted;
    await run();
    rejectOther!(new Error('regular log failed'));
    await other;
    const current = useHabitStore.getState().habits;
    expect(
      current
        .find((habit) => habit.id === HABIT_ID)!
        .completions!.reduce((sum, completion) => sum + completion.completed_units, 0),
    ).toBe(10);
    expect(current.find((habit) => habit.id === otherId)!.completions).toEqual([]);
    expect(await loadHabits()).toEqual(current);
  });

  it('a confirmed late response does not resurrect a habit deleted while the request was pending', async () => {
    let finish: ((_result: ReturnType<typeof serverResult>) => void) | undefined;
    let posted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      posted = resolve;
    });
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          posted!();
        }),
    );
    let linked = true;
    const pending = run({ isCurrent: () => linked });
    await ready;
    linked = false;
    useHabitStore.getState().setHabits([]);
    await saveHabits([]);
    finish!(serverResult(10));
    await pending;
    expect(useHabitStore.getState().habits).toEqual([]);
    expect(await loadHabits()).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a load that throws is swallowed, never surfaced to the writer', async () => {
    useHabitStore.getState().setHabits([]);
    jest.spyOn(habitManager, 'refreshHabits').mockRejectedValue(new Error('boom'));

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
