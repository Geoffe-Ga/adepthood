/**
 * Store integration tests — verify Zustand stores interact correctly
 * with hooks and maintain consistent state across multiple consumers.
 *
 * These tests go beyond unit-testing individual store methods by
 * exercising realistic multi-step flows that span the store boundary.
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { Habit } from '../../features/Habits/Habits.types';

// Mock dependencies before importing hooks
jest.mock('../../api', () => ({
  habits: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
    delete: jest.fn(() => Promise.resolve({})),
  },
  goalCompletions: {
    create: jest.fn(() => Promise.resolve({ streak: 1, milestones: [], reason_code: 'ok' })),
  },
}));

jest.mock('../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notif-id')),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve(undefined)),
  getAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve([])),
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

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [
    {
      id: 1,
      title: 'Low',
      tier: 'low',
      target: 1,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [],
  revealed: true,
  ...overrides,
});

describe('Store integration', () => {
  beforeEach(() => {
    const { useHabitStore } = require('../useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('useHabits hook mutations are reflected in global store', () => {
    const { useHabits } = require('../../features/Habits/hooks/useHabits');
    const { useHabitStore } = require('../useHabitStore');

    const habit = makeHabit();
    const { result } = renderHook(() => useHabits());

    // Set habits via hook
    act(() => result.current.setHabitsForTesting([habit]));

    // Global store should reflect the same habits
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(useHabitStore.getState().habits[0]!.name).toBe('Test Habit');

    // Update via hook action
    act(() => result.current.actions.updateHabit({ ...habit, name: 'Updated Habit' }));

    // Store should be updated
    expect(useHabitStore.getState().habits[0]!.name).toBe('Updated Habit');
  });

  it('store mutations from one hook instance are visible to another', () => {
    const { useHabits } = require('../../features/Habits/hooks/useHabits');

    const habit = makeHabit();

    // Simulate two "screens" both using useHabits
    const { result: screen1 } = renderHook(() => useHabits());
    const { result: screen2 } = renderHook(() => useHabits());

    // Screen 1 sets habits
    act(() => screen1.current.setHabitsForTesting([habit]));

    // Screen 2 should see the same habits (shared global state)
    expect(screen2.current.habits).toHaveLength(1);
    expect(screen2.current.habits[0]!.name).toBe('Test Habit');
  });

  it('removeHabit from store propagates to hook consumers', () => {
    const { useHabits } = require('../../features/Habits/hooks/useHabits');
    const { useHabitStore } = require('../useHabitStore');

    const habits = [makeHabit({ id: 1, name: 'First' }), makeHabit({ id: 2, name: 'Second' })];

    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(habits));
    expect(result.current.habits).toHaveLength(2);

    // Remove via store directly
    act(() => useHabitStore.getState().removeHabit(1));

    // Hook consumer should see the removal
    expect(result.current.habits).toHaveLength(1);
    expect(result.current.habits[0]!.name).toBe('Second');
  });

  it('error state flows from store to hook consumer', () => {
    const { useHabits } = require('../../features/Habits/hooks/useHabits');
    const { useHabitStore } = require('../useHabitStore');

    const { result } = renderHook(() => useHabits());

    // Initially no error
    expect(result.current.error).toBeNull();

    // Set error via store
    act(() => useHabitStore.getState().setError('Network error'));

    // Hook reflects the error
    expect(result.current.error).toBe('Network error');

    // Clear error
    act(() => useHabitStore.getState().setError(null));
    expect(result.current.error).toBeNull();
  });

  it('loading state transitions: idle → loading → loaded', () => {
    const { useHabits } = require('../../features/Habits/hooks/useHabits');
    const { useHabitStore } = require('../useHabitStore');

    const { result } = renderHook(() => useHabits());

    // Simulate loading flow
    act(() => useHabitStore.getState().setLoading(true));
    expect(result.current.loading).toBe(true);

    act(() => {
      useHabitStore.getState().setHabits([makeHabit()]);
      useHabitStore.getState().setLoading(false);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.habits).toHaveLength(1);
  });
});
