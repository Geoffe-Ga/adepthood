/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: 'UTC' }),
}));

const mockLoadHabits = jest.fn();
jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    loadHabits: (...args: unknown[]) => mockLoadHabits(...args),
  },
}));

import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitStore } from '@/store/useHabitStore';

const { useHabitsSummary } = require('../useHabitsSummary');

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: 'leaf',
  streak: 0,
  energy_cost: 5,
  energy_return: 5,
  start_date: new Date('2020-01-01T00:00:00Z'),
  goals: [],
  completions: [],
  revealed: true,
  ...overrides,
});

beforeEach(() => {
  mockLoadHabits.mockClear();
  useHabitStore.setState({
    loading: false,
    habits: [],
    habitsById: {},
    habitOrder: [],
    error: null,
  });
});

describe('useHabitsSummary', () => {
  it('calls habitManager.loadHabits with the user timezone on mount', () => {
    renderHook(() => useHabitsSummary());
    expect(mockLoadHabits).toHaveBeenCalledWith('UTC');
  });

  it('showSkeleton is true while loading with no habits yet', () => {
    useHabitStore.setState({ loading: true, habits: [] });
    const { result } = renderHook(() => useHabitsSummary());
    expect(result.current.showSkeleton).toBe(true);
  });

  it('showSkeleton is false once habits are present even if loading is still true', () => {
    useHabitStore.setState({ loading: true, habits: [makeHabit({ revealed: true })] });
    const { result } = renderHook(() => useHabitsSummary());
    expect(result.current.showSkeleton).toBe(false);
  });

  it('derives habitCount, unlockedCount, and doneCount from the store habits', () => {
    const habits = [
      makeHabit({
        id: 1,
        revealed: true,
        completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
      }),
      makeHabit({ id: 2, revealed: true }),
      makeHabit({ id: 3, revealed: false }),
    ];
    useHabitStore.setState({ loading: false, habits });
    const { result } = renderHook(() => useHabitsSummary());
    expect(result.current).toEqual({
      showSkeleton: false,
      habitCount: 3,
      unlockedCount: 2,
      doneCount: 1,
    });
  });
});
