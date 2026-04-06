/**
 * Integration tests for Habits feature flows.
 *
 * These tests exercise multi-step user flows using the useHabits hook
 * with mocked API and storage layers, verifying that state transitions
 * and side effects work correctly together.
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { Goal, Habit } from '../Habits.types';
import { useHabits } from '../hooks/useHabits';
import { useModalCoordinator } from '../hooks/useModalCoordinator';

// Mock dependencies
jest.mock('../../../api', () => ({
  habits: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() =>
      Promise.resolve({
        id: 100,
        name: 'New',
        icon: '🌟',
        start_date: '2025-01-01',
        energy_cost: 1,
        energy_return: 2,
        stage: 'Beige',
        streak: 0,
        notification_times: null,
        notification_frequency: null,
        notification_days: null,
        milestone_notifications: false,
        sort_order: null,
        goals: [],
      }),
    ),
    update: jest.fn(() => Promise.resolve({})),
    delete: jest.fn(() => Promise.resolve({})),
  },
  goalCompletions: {
    create: jest.fn(() => Promise.resolve({ streak: 1, milestones: [], reason_code: 'ok' })),
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
  getAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve([])),
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly' },
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

const makeGoal = (tier: 'low' | 'clear' | 'stretch', target: number): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: tier,
  tier,
  target,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low', 1), makeGoal('clear', 3), makeGoal('stretch', 5)],
  completions: [],
  revealed: true,
  ...overrides,
});

describe('Habits integration flows', () => {
  beforeEach(() => {
    const { useHabitStore } = require('../../../store/useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('select habit → open goal modal → close all modals', () => {
    const habit = makeHabit();
    const { result: habitsResult } = renderHook(() => useHabits());
    const { result: modalsResult } = renderHook(() => useModalCoordinator());

    // Set habits and select one
    act(() => habitsResult.current.setHabitsForTesting([habit]));
    act(() => habitsResult.current.setSelectedHabit(habit));

    expect(habitsResult.current.selectedHabit).toBeTruthy();
    expect(habitsResult.current.selectedHabit!.id).toBe(1);

    // Open goal modal
    act(() => modalsResult.current.open('goal'));
    expect(modalsResult.current.goal).toBe(true);
    expect(modalsResult.current.stats).toBe(false);

    // Close all modals
    act(() => modalsResult.current.closeAll());
    expect(modalsResult.current.goal).toBe(false);
  });

  it('log units → progress updates → completions array grows', () => {
    const habit = makeHabit();
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([habit]));

    // Log 2 units
    act(() => result.current.actions.logUnit(1, 2));

    const updated = result.current.habits.find((h) => h.id === 1);
    expect(updated).toBeTruthy();
    expect(updated!.completions).toBeTruthy();
    expect(updated!.completions!.length).toBe(1);
    expect(updated!.completions![0]!.completed_units).toBe(2);

    // Log 3 more units
    act(() => result.current.actions.logUnit(1, 3));

    const afterSecondLog = result.current.habits.find((h) => h.id === 1);
    expect(afterSecondLog!.completions!.length).toBe(2);

    // Total progress should be 2 + 3 = 5
    const totalProgress = afterSecondLog!.completions!.reduce(
      (sum, c) => sum + c.completed_units,
      0,
    );
    expect(totalProgress).toBe(5);
  });

  it('update goal → tier hierarchy enforced for additive goals', () => {
    const habit = makeHabit();
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([habit]));

    // Update low goal target to 10 (higher than clear=3)
    const updatedLowGoal = { ...makeGoal('low', 10), target_unit: 'units' };
    act(() => result.current.actions.updateGoal(1, updatedLowGoal));

    const updated = result.current.habits.find((h) => h.id === 1);
    const low = updated!.goals.find((g) => g.tier === 'low');
    const clear = updated!.goals.find((g) => g.tier === 'clear');
    const stretch = updated!.goals.find((g) => g.tier === 'stretch');

    // Tier hierarchy: low <= clear <= stretch (for additive goals)
    expect(low!.target).toBe(10);
    expect(clear!.target).toBeGreaterThanOrEqual(low!.target);
    expect(stretch!.target).toBeGreaterThanOrEqual(clear!.target);
  });

  it('save habit order → habits reordered correctly', () => {
    const habitA = makeHabit({ id: 1, name: 'Alpha' });
    const habitB = makeHabit({ id: 2, name: 'Bravo' });
    const habitC = makeHabit({ id: 3, name: 'Charlie' });
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([habitA, habitB, habitC]));
    expect(result.current.habits.map((h) => h.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);

    // Reorder: Charlie first, then Alpha, then Bravo
    act(() => result.current.actions.saveHabitOrder([habitC, habitA, habitB]));

    expect(result.current.habits.map((h) => h.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('delete habit → removed from habits list', () => {
    const habits = [makeHabit({ id: 1, name: 'Keep' }), makeHabit({ id: 2, name: 'Remove' })];
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting(habits));
    expect(result.current.habits).toHaveLength(2);

    act(() => result.current.actions.deleteHabit(2));

    expect(result.current.habits).toHaveLength(1);
    expect(result.current.habits[0]!.name).toBe('Keep');
  });

  it('mode transitions: normal → stats → edit → normal', () => {
    const { result } = renderHook(() => useHabits());

    expect(result.current.mode).toBe('normal');

    act(() => result.current.setMode('stats'));
    expect(result.current.mode).toBe('stats');

    act(() => result.current.setMode('edit'));
    expect(result.current.mode).toBe('edit');

    act(() => result.current.setMode('normal'));
    expect(result.current.mode).toBe('normal');
  });
});
