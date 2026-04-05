import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Habit } from '../../features/Habits/Habits.types';

// Mock dependencies
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

describe('useHabitStore', () => {
  beforeEach(() => {
    // Reset store state between tests
    const { useHabitStore } = require('../useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('has correct initial state', () => {
    const { useHabitStore } = require('../useHabitStore');
    const state = useHabitStore.getState();

    expect(state.habits).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('setHabits updates habits array', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit();

    act(() => useHabitStore.getState().setHabits([habit]));

    expect(useHabitStore.getState().habits).toEqual([habit]);
  });

  it('setLoading updates loading flag', () => {
    const { useHabitStore } = require('../useHabitStore');

    act(() => useHabitStore.getState().setLoading(true));
    expect(useHabitStore.getState().loading).toBe(true);

    act(() => useHabitStore.getState().setLoading(false));
    expect(useHabitStore.getState().loading).toBe(false);
  });

  it('setError updates error message', () => {
    const { useHabitStore } = require('../useHabitStore');

    act(() => useHabitStore.getState().setError('Something went wrong'));
    expect(useHabitStore.getState().error).toBe('Something went wrong');

    act(() => useHabitStore.getState().setError(null));
    expect(useHabitStore.getState().error).toBeNull();
  });

  it('updateHabit replaces a habit by id', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit({ name: 'Original' });

    act(() => useHabitStore.getState().setHabits([habit]));
    act(() => useHabitStore.getState().updateHabit({ ...habit, name: 'Updated' }));

    expect(useHabitStore.getState().habits[0]!.name).toBe('Updated');
  });

  it('updateHabit does nothing when id not found', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit({ id: 1 });

    act(() => useHabitStore.getState().setHabits([habit]));
    act(() => useHabitStore.getState().updateHabit(makeHabit({ id: 99, name: 'Nope' })));

    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(useHabitStore.getState().habits[0]!.name).toBe('Test Habit');
  });

  it('removeHabit removes a habit by id', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit();

    act(() => useHabitStore.getState().setHabits([habit]));
    expect(useHabitStore.getState().habits).toHaveLength(1);

    act(() => useHabitStore.getState().removeHabit(1));
    expect(useHabitStore.getState().habits).toHaveLength(0);
  });

  it('removeHabit is a no-op when id not found', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit({ id: 1 });

    act(() => useHabitStore.getState().setHabits([habit]));
    act(() => useHabitStore.getState().removeHabit(99));

    expect(useHabitStore.getState().habits).toHaveLength(1);
  });

  it('state is shared across multiple getState calls (global store)', () => {
    const { useHabitStore } = require('../useHabitStore');
    const habit = makeHabit();

    act(() => useHabitStore.getState().setHabits([habit]));

    // A second "consumer" sees the same state
    const stateFromSecondCall = useHabitStore.getState();
    expect(stateFromSecondCall.habits).toEqual([habit]);
  });
});
