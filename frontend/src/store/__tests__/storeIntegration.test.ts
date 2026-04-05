import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Habit } from '../../features/Habits/Habits.types';

// Mock the API layer
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
  stages: {
    list: jest.fn(() => Promise.resolve([])),
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

describe('Store integration: useHabitStore multi-operation flows', () => {
  beforeEach(() => {
    const { useHabitStore } = require('../useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('setHabits then updateHabit produces correct final state', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habits = [
      makeHabit({ id: 1, name: 'Meditation' }),
      makeHabit({ id: 2, name: 'Exercise' }),
      makeHabit({ id: 3, name: 'Reading' }),
    ];

    act(() => useHabitStore.getState().setHabits(habits));
    expect(useHabitStore.getState().habits).toHaveLength(3);

    // Update the second habit
    const updatedExercise = makeHabit({ id: 2, name: 'Running', streak: 10 });
    act(() => useHabitStore.getState().updateHabit(updatedExercise));

    const state = useHabitStore.getState();
    expect(state.habits).toHaveLength(3);
    expect(state.habits[1]!.name).toBe('Running');
    expect(state.habits[1]!.streak).toBe(10);
    // Others are untouched
    expect(state.habits[0]!.name).toBe('Meditation');
    expect(state.habits[2]!.name).toBe('Reading');
  });

  it('setHabits then removeHabit then updateHabit on remaining', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habits = [
      makeHabit({ id: 1, name: 'A' }),
      makeHabit({ id: 2, name: 'B' }),
      makeHabit({ id: 3, name: 'C' }),
    ];

    act(() => useHabitStore.getState().setHabits(habits));

    // Remove middle habit
    act(() => useHabitStore.getState().removeHabit(2));
    expect(useHabitStore.getState().habits).toHaveLength(2);

    // Update one of the remaining
    act(() => useHabitStore.getState().updateHabit(makeHabit({ id: 3, name: 'C-Updated' })));
    const names = useHabitStore.getState().habits.map((h: Habit) => h.name);
    expect(names).toEqual(['A', 'C-Updated']);
  });

  it('loading flag transitions through a simulated fetch cycle', () => {
    const { useHabitStore } = require('../useHabitStore');

    // Start loading
    act(() => useHabitStore.getState().setLoading(true));
    expect(useHabitStore.getState().loading).toBe(true);

    // Simulate receiving data
    const habits = [makeHabit({ id: 1 })];
    act(() => {
      useHabitStore.getState().setHabits(habits);
      useHabitStore.getState().setLoading(false);
    });

    expect(useHabitStore.getState().loading).toBe(false);
    expect(useHabitStore.getState().habits).toHaveLength(1);
  });

  it('error state clears when new data arrives', () => {
    const { useHabitStore } = require('../useHabitStore');

    // Simulate failed fetch
    act(() => {
      useHabitStore.getState().setError('Network error');
      useHabitStore.getState().setLoading(false);
    });
    expect(useHabitStore.getState().error).toBe('Network error');

    // Simulate successful retry
    act(() => {
      useHabitStore.getState().setError(null);
      useHabitStore.getState().setHabits([makeHabit()]);
    });
    expect(useHabitStore.getState().error).toBeNull();
    expect(useHabitStore.getState().habits).toHaveLength(1);
  });

  it('rapid sequential updates produce consistent state', () => {
    const { useHabitStore } = require('../useHabitStore');

    // Populate with 5 habits
    const habits = Array.from({ length: 5 }, (_, i) =>
      makeHabit({ id: i + 1, name: `Habit-${i + 1}` }),
    );
    act(() => useHabitStore.getState().setHabits(habits));

    // Rapidly update and remove in sequence
    act(() => {
      useHabitStore.getState().updateHabit(makeHabit({ id: 1, name: 'Updated-1' }));
      useHabitStore.getState().removeHabit(3);
      useHabitStore.getState().updateHabit(makeHabit({ id: 5, name: 'Updated-5' }));
      useHabitStore.getState().removeHabit(2);
    });

    const state = useHabitStore.getState();
    expect(state.habits).toHaveLength(3);
    const names = state.habits.map((h: Habit) => h.name);
    expect(names).toEqual(['Updated-1', 'Habit-4', 'Updated-5']);
  });
});
