/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Habit } from '../../features/Habits/Habits.types';
import { clearHabits, loadHabits, saveHabits } from '../habitStorage';
import { _resetSerializedWriteForTests } from '../serializedWrite';
import { beginActiveUserTransition, setActiveUser } from '../userScope';

/**
 * #3372: a habit-cache write that has already reached the disk call when
 * account cleanup starts must not commit after the cleanup's clear.
 *
 * The generation guard callers check before ``saveHabits`` fences the *start*
 * of a write, not its eventual commit. These tests hold a real write on the
 * in-memory AsyncStorage mock (``src/__mocks__/async-storage.js``), run the
 * cleanup, release the write, and then read what is actually on the device.
 */

const USER_A = 1;
const USER_B = 2;
const HABITS_KEY_BASE = '@adepthood/habits';

const habitNamed = (id: number, name: string): Habit => ({
  id,
  stage: 'Beige',
  name,
  icon: '🧘',
  streak: 1,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2026-09-01T00:00:00.000Z'),
  goals: [],
  completions: [],
  revealed: true,
});

const realSetItem = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;

interface HeldWrite {
  /** Resolves once the held write has entered ``AsyncStorage.setItem``. */
  started: Promise<void>;
  /** Commit the held write to the store. */
  release: () => void;
}

/** Hold the next habit-cache ``setItem`` until ``release`` is called. */
function holdNextHabitWrite(): HeldWrite {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key: string, value: string) => {
    expect(key.startsWith(HABITS_KEY_BASE)).toBe(true);
    markStarted();
    await gate;
    await realSetItem(key, value);
  });
  return { started, release };
}

/** ``wipeUserState``'s habit half, in the order ``AuthContext`` runs it. */
function startCleanup(outgoing: number | null): Promise<void> {
  setActiveUser(outgoing);
  beginActiveUserTransition();
  return clearHabits();
}

const namesOf = (habits: Habit[] | null): string[] | null =>
  habits === null ? null : habits.map((habit) => habit.name);

/** Read ``user``'s cache as an offline resume of that account would. */
async function readCacheAs(user: number | null): Promise<string[] | null> {
  setActiveUser(user);
  return namesOf(await loadHabits());
}

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.mocked(AsyncStorage.setItem).mockImplementation(realSetItem);
});

describe('habit cache writes are fenced by account cleanup (#3372)', () => {
  test('a refresh write already in flight cannot resurrect rows after logout cleanup', async () => {
    setActiveUser(USER_A);
    await saveHabits([habitNamed(1, 'A before refresh')]);
    const held = holdNextHabitWrite();
    const refreshWrite = saveHabits([habitNamed(1, 'A refreshed')]);
    await held.started;

    const cleanup = startCleanup(USER_A);
    held.release();
    await Promise.all([refreshWrite, cleanup]);
    setActiveUser(null);

    expect(await readCacheAs(USER_A)).toBeNull();
  });

  test('A→B: the outgoing write stays gone and the incoming account is untouched', async () => {
    setActiveUser(USER_B);
    await saveHabits([habitNamed(2, 'B own row')]);
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const refreshWrite = saveHabits([habitNamed(1, 'A refreshed')]);
    await held.started;

    const cleanup = startCleanup(USER_A);
    held.release();
    await Promise.all([refreshWrite, cleanup]);
    setActiveUser(USER_B);

    expect(await readCacheAs(USER_B)).toEqual(['B own row']);
    expect(await readCacheAs(USER_A)).toBeNull();
  });

  test('A→B→A: the returning account persists durably and the stale write never lands', async () => {
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const staleWrite = saveHabits([habitNamed(1, 'A stale')]);
    await held.started;

    const cleanup = startCleanup(USER_A);
    held.release();
    await Promise.all([staleWrite, cleanup]);
    setActiveUser(USER_B);
    await saveHabits([habitNamed(2, 'B own row')]);
    setActiveUser(USER_A);
    await saveHabits([habitNamed(3, 'A returned')]);

    expect(await readCacheAs(USER_A)).toEqual(['A returned']);
    expect(await readCacheAs(USER_B)).toEqual(['B own row']);
  });

  test('a write captured before cleanup but still queued is dropped, not committed', async () => {
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const first = saveHabits([habitNamed(1, 'A first')]);
    await held.started;
    const queued = saveHabits([habitNamed(1, 'A queued')]);

    const cleanup = startCleanup(USER_A);
    held.release();
    await Promise.all([first, queued, cleanup]);

    expect(await readCacheAs(USER_A)).toBeNull();
  });

  test('repeated cleanup over a held write still ends with no rows', async () => {
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const refreshWrite = saveHabits([habitNamed(1, 'A refreshed')]);
    await held.started;

    const firstCleanup = startCleanup(USER_A);
    const secondCleanup = startCleanup(USER_A);
    held.release();
    await Promise.all([refreshWrite, firstCleanup, secondCleanup]);
    setActiveUser(null);

    expect(await readCacheAs(USER_A)).toBeNull();
  });

  test('legitimate concurrent same-owner writes commit in call order and stay durable', async () => {
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const first = saveHabits([habitNamed(1, 'A first')]);
    await held.started;
    const second = saveHabits([habitNamed(1, 'A second')]);

    held.release();
    await Promise.all([first, second]);

    expect(await readCacheAs(USER_A)).toEqual(['A second']);
  });

  test('a same-owner re-authentication (no cleanup) keeps the in-flight write', async () => {
    setActiveUser(USER_A);
    const held = holdNextHabitWrite();
    const write = saveHabits([habitNamed(1, 'A kept')]);
    await held.started;

    setActiveUser(USER_A);
    held.release();
    await write;

    expect(await readCacheAs(USER_A)).toEqual(['A kept']);
  });
});
