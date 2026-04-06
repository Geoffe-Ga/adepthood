/**
 * Integration tests for the onboarding → habit creation pipeline.
 *
 * Verifies that onboarding habits integrate correctly with the
 * useHabits hook actions and utility functions end-to-end.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { Habit, Goal } from '../Habits.types';
import { calculateHabitProgress, getGoalTier, getProgressPercentage } from '../HabitUtils';
import { useHabits } from '../hooks/useHabits';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../api', () => ({
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

jest.mock('../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notif-id')),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve(undefined)),
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly' },
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (s: Record<string, unknown>) => s },
  Animated: {
    Value: jest.fn(),
    View: 'Animated.View',
    timing: jest.fn(() => ({ start: jest.fn() })),
    parallel: jest.fn(() => ({ start: jest.fn() })),
  },
  View: 'View',
  Text: 'Text',
}));

// ---------------------------------------------------------------------------
// Fixtures — simulate what OnboardingModal produces
// ---------------------------------------------------------------------------

const makeOnboardedHabits = (): Habit[] => [
  {
    id: 1,
    name: 'Meditate',
    icon: '🧘',
    energy_cost: 2,
    energy_return: 4,
    stage: 'Beige',
    start_date: new Date('2025-01-01'),
    streak: 0,
    revealed: true,
    completions: [],
    goals: [
      {
        id: 1,
        title: 'Low goal for Meditate',
        tier: 'low',
        target: 1,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        title: 'Clear goal for Meditate',
        tier: 'clear',
        target: 2,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        title: 'Stretch goal for Meditate',
        tier: 'stretch',
        target: 3,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ],
  },
  {
    id: 2,
    name: 'Exercise',
    icon: '🏃',
    energy_cost: 3,
    energy_return: 5,
    stage: 'Beige',
    start_date: new Date('2025-01-01'),
    streak: 0,
    revealed: true,
    completions: [],
    goals: [
      {
        id: 4,
        title: 'Low goal for Exercise',
        tier: 'low',
        target: 1,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 5,
        title: 'Clear goal for Exercise',
        tier: 'clear',
        target: 2,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 6,
        title: 'Stretch goal for Exercise',
        tier: 'stretch',
        target: 3,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Onboarding → Habit lifecycle flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { useHabitStore } = require('../../../store/useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
  });

  it('onboarded habits start with zero progress at lowest tier', () => {
    const { result } = renderHook(() => useHabits());
    const habits = makeOnboardedHabits();

    act(() => result.current.setHabitsForTesting(habits));

    for (const habit of result.current.habits) {
      expect(calculateHabitProgress(habit)).toBe(0);
      const { currentGoal, completedAllGoals } = getGoalTier(habit);
      // At zero progress, current goal is the "low" tier and nothing is completed
      expect(currentGoal.tier).toBe('low');
      expect(completedAllGoals).toBe(false);
    }
  });

  it('logging units advances through goal tiers correctly', () => {
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(makeOnboardedHabits()));

    // Log 1 unit — meets "low" tier (target=1)
    act(() => result.current.actions.logUnit(1, 1));
    let habit = result.current.habits.find((h: Habit) => h.id === 1)!;
    let { currentGoal, nextGoal } = getGoalTier(habit);
    expect(currentGoal?.tier).toBe('low');
    expect(nextGoal?.tier).toBe('clear');

    // Log 1 more unit — meets "clear" tier (target=2)
    act(() => result.current.actions.logUnit(1, 1));
    habit = result.current.habits.find((h: Habit) => h.id === 1)!;
    ({ currentGoal, nextGoal } = getGoalTier(habit));
    expect(currentGoal?.tier).toBe('clear');
    expect(nextGoal?.tier).toBe('stretch');

    // Log 1 more — meets "stretch" tier (target=3)
    act(() => result.current.actions.logUnit(1, 1));
    habit = result.current.habits.find((h: Habit) => h.id === 1)!;
    ({ currentGoal } = getGoalTier(habit));
    expect(currentGoal?.tier).toBe('stretch');
  });

  it('progress percentage scales between tier boundaries', () => {
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(makeOnboardedHabits()));

    // Log 1.5 units — between low (1) and clear (2)
    act(() => result.current.actions.logUnit(1, 1));
    act(() => result.current.actions.logUnit(1, 0.5));

    const habit = result.current.habits.find((h: Habit) => h.id === 1)!;
    const { currentGoal, nextGoal } = getGoalTier(habit);
    const pct = getProgressPercentage(habit, currentGoal, nextGoal);

    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it('updating a goal on one habit does not affect the other', () => {
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(makeOnboardedHabits()));

    // Raise Meditate's low goal target
    const newLow: Goal = {
      id: 1,
      title: 'Low goal for Meditate',
      tier: 'low',
      target: 5,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };

    act(() => result.current.actions.updateGoal(1, newLow));

    // Exercise's goals should be unchanged
    const exercise = result.current.habits.find((h: Habit) => h.id === 2)!;
    const exerciseLow = exercise.goals.find((g: Goal) => g.tier === 'low')!;
    expect(exerciseLow.target).toBe(1);
  });

  it('delete removes a habit without affecting siblings', () => {
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(makeOnboardedHabits()));
    expect(result.current.habits).toHaveLength(2);

    act(() => result.current.actions.deleteHabit(1));
    expect(result.current.habits).toHaveLength(1);
    expect(result.current.habits[0]!.name).toBe('Exercise');
  });
});
