/**
 * Integration tests for useHabitStore — multi-step flows that verify
 * state consistency across sequences of store operations.
 *
 * Unlike the unit tests which test individual actions in isolation, these
 * tests verify that chained operations (populate → update → remove → verify)
 * produce correct composite state.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Habit } from '../../features/Habits/Habits.types';
import type { HabitStoreState } from '../useHabitStore';

type StoreApi = {
  getState: () => HabitStoreState;
  setState: (s: Partial<HabitStoreState>) => void;
};

jest.mock('../../api', () => ({
  habits: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
    delete: jest.fn(() => Promise.resolve({})),
  },
  goalCompletions: {
    create: jest.fn(() => Promise.resolve({})),
  },
}));

jest.mock('../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
}));

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [],
  completions: [],
  revealed: true,
  ...overrides,
});

describe('useHabitStore integration flows', () => {
  const getStore = (): StoreApi =>
    (require('../useHabitStore') as { useHabitStore: StoreApi }).useHabitStore;

  beforeEach(() => {
    getStore().setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('populate → update multiple → verify all changes persisted', () => {
    const store = getStore();
    const habits = [
      makeHabit({ id: 1, name: 'Meditation' }),
      makeHabit({ id: 2, name: 'Running' }),
      makeHabit({ id: 3, name: 'Reading' }),
    ];

    // Populate store
    act(() => store.getState().setHabits(habits));
    expect(store.getState().habits).toHaveLength(3);

    // Update two habits
    act(() => store.getState().updateHabit(makeHabit({ id: 1, name: 'Deep Meditation' })));
    act(() => store.getState().updateHabit(makeHabit({ id: 3, name: 'Speed Reading' })));

    const state = store.getState();
    expect(state.habits).toHaveLength(3);
    expect(state.habits[0]!.name).toBe('Deep Meditation');
    expect(state.habits[1]!.name).toBe('Running'); // unchanged
    expect(state.habits[2]!.name).toBe('Speed Reading');
  });

  it('populate → remove → update remaining → state is consistent', () => {
    const store = getStore();
    const habits = [
      makeHabit({ id: 1, name: 'Meditation' }),
      makeHabit({ id: 2, name: 'Running' }),
      makeHabit({ id: 3, name: 'Reading' }),
    ];

    act(() => store.getState().setHabits(habits));

    // Remove the middle habit
    act(() => store.getState().removeHabit(2));
    expect(store.getState().habits).toHaveLength(2);

    // Update a remaining habit
    act(() => store.getState().updateHabit(makeHabit({ id: 1, name: 'Updated Meditation' })));

    const state = store.getState();
    expect(state.habits).toHaveLength(2);
    expect(state.habits.find((h: Habit) => h.id === 1)!.name).toBe('Updated Meditation');
    expect(state.habits.find((h: Habit) => h.id === 3)!.name).toBe('Reading');
    // Removed habit is truly gone
    expect(state.habits.find((h: Habit) => h.id === 2)).toBeUndefined();
  });

  it('loading and error state transitions during a simulated fetch cycle', () => {
    const store = getStore();

    // Simulate fetch start
    act(() => {
      store.getState().setLoading(true);
      store.getState().setError(null);
    });

    expect(store.getState().loading).toBe(true);
    expect(store.getState().error).toBeNull();

    // Simulate fetch success
    const fetched = [makeHabit({ id: 10, name: 'From API' })];
    act(() => {
      store.getState().setHabits(fetched);
      store.getState().setLoading(false);
    });

    const state = store.getState();
    expect(state.loading).toBe(false);
    expect(state.habits).toHaveLength(1);
    expect(state.habits[0]!.name).toBe('From API');
  });

  it('loading and error state transitions during a simulated fetch failure', () => {
    const store = getStore();

    // Start loading
    act(() => {
      store.getState().setLoading(true);
      store.getState().setError(null);
    });

    // Simulate failure — set error, stop loading, keep habits empty
    act(() => {
      store.getState().setError('Network error');
      store.getState().setLoading(false);
    });

    const state = store.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('Network error');
    expect(state.habits).toEqual([]);
  });

  it('optimistic update → revert on error maintains original state', () => {
    const store = getStore();
    const original = [
      makeHabit({ id: 1, name: 'Meditation', streak: 5 }),
      makeHabit({ id: 2, name: 'Running', streak: 3 }),
    ];

    // Set original state
    act(() => store.getState().setHabits(original));

    // Optimistic update (e.g., user logs a unit)
    const optimistic = original.map((h) => (h.id === 1 ? { ...h, streak: 6 } : h));
    act(() => store.getState().setHabits(optimistic));
    expect(store.getState().habits[0]!.streak).toBe(6);

    // Revert on API failure
    act(() => store.getState().setHabits(original));
    expect(store.getState().habits[0]!.streak).toBe(5);
    expect(store.getState().habits[1]!.streak).toBe(3);
  });

  it('bulk replace followed by individual mutations keeps store coherent', () => {
    const store = getStore();

    // Initial bulk load
    const batch1 = [makeHabit({ id: 1, name: 'A' }), makeHabit({ id: 2, name: 'B' })];
    act(() => store.getState().setHabits(batch1));

    // Full replace (e.g., re-fetch from API returns different set)
    const batch2 = [
      makeHabit({ id: 3, name: 'C' }),
      makeHabit({ id: 4, name: 'D' }),
      makeHabit({ id: 5, name: 'E' }),
    ];
    act(() => store.getState().setHabits(batch2));
    expect(store.getState().habits).toHaveLength(3);

    // Individual mutation on new set
    act(() => store.getState().updateHabit(makeHabit({ id: 4, name: 'D-updated' })));

    const state = store.getState();
    expect(state.habits).toHaveLength(3);
    expect(state.habits.find((h: Habit) => h.id === 4)!.name).toBe('D-updated');
    // Old habits are completely gone
    expect(state.habits.find((h: Habit) => h.id === 1)).toBeUndefined();
  });
});
