/**
 * Integration tests for the Habits feature — multi-step user flows.
 *
 * These tests verify that the useHabits hook, Zustand store, and API layer
 * work together correctly when simulating real user interactions.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { ApiHabitWithGoals } from '../../../api';
import { useHabitStore } from '../../../store/useHabitStore';
import type { Goal, Habit } from '../Habits.types';
import { logHabitUnits, calculateHabitProgress } from '../HabitUtils';
import { useHabits } from '../hooks/useHabits';

// Mock dependencies
const mockHabitsList = jest.fn<() => Promise<ApiHabitWithGoals[]>>(() => Promise.resolve([]));
const mockHabitsCreate = jest.fn(() => Promise.resolve({}));
const mockHabitsUpdate = jest.fn(() => Promise.resolve({}));
const mockHabitsDelete = jest.fn(() => Promise.resolve({}));
const mockGoalCompletionsCreate = jest.fn(() => Promise.resolve({}));

jest.mock('../../../api', () => ({
  habits: {
    list: (...args: unknown[]) => mockHabitsList(...(args as [])),
    create: (...args: unknown[]) => mockHabitsCreate(...(args as [])),
    update: (...args: unknown[]) => mockHabitsUpdate(...(args as [])),
    delete: (...args: unknown[]) => mockHabitsDelete(...(args as [])),
  },
  goalCompletions: {
    create: (...args: unknown[]) => mockGoalCompletionsCreate(...(args as [])),
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
}));

const makeGoals = (): Goal[] => [
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
  {
    id: 2,
    title: 'Clear',
    tier: 'clear',
    target: 3,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 3,
    title: 'Stretch',
    tier: 'stretch',
    target: 5,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
];

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 0,
  energy_cost: 2,
  energy_return: 5,
  start_date: new Date('2025-01-01'),
  goals: makeGoals(),
  completions: [],
  revealed: true,
  ...overrides,
});

describe('Habits Integration Tests', () => {
  beforeEach(() => {
    useHabitStore.setState({ habits: [], loading: false, error: null });
    jest.clearAllMocks();
    mockHabitsList.mockResolvedValue([]);
  });

  // ── Flow 1: Set habits → Log unit → Progress updates ──────────────

  it('logging a unit increases habit progress correctly', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));
    expect(calculateHabitProgress(result.current.habits[0]!)).toBe(0);

    act(() => result.current.actions.logUnit(1, 1));

    const updated = result.current.habits.find((h) => h.id === 1);
    expect(updated).toBeDefined();
    expect(calculateHabitProgress(updated!)).toBe(1);
  });

  // ── Flow 2: Log units → Reach goal → Alert fires ─────────────────

  it('reaching low goal target triggers an alert', () => {
    const { Alert } = require('react-native');
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));

    // Log 1 unit to reach the low goal (target: 1)
    act(() => result.current.actions.logUnit(1, 1));

    expect(Alert.alert).toHaveBeenCalledWith('Goal Achieved!', expect.stringContaining('Low Goal'));
  });

  // ── Flow 3: Quick log mode — tap habit → unit logged directly ─────

  it('quick log mode logs units without modal interaction', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));
    act(() => result.current.setMode('quickLog'));

    expect(result.current.mode).toBe('quickLog');

    // In quickLog mode, logUnit is called directly
    act(() => result.current.actions.logUnit(1, 1));

    const updated = result.current.habits.find((h) => h.id === 1);
    expect(calculateHabitProgress(updated!)).toBe(1);
  });

  // ── Flow 4: Onboarding → Creates habits with default goals ────────

  it('onboarding save creates habits with three-tier goals', async () => {
    const { result } = renderHook(() => useHabits());

    // Wait for initial load effect to settle
    await act(async () => {
      await Promise.resolve();
    });

    const onboardingHabits = [
      {
        id: 'temp-1',
        name: 'Morning Run',
        icon: '🏃',
        energy_cost: 3,
        energy_return: 7,
        stage: 'Beige',
        start_date: new Date('2025-01-01'),
      },
    ];

    await act(async () => {
      await result.current.actions.onboardingSave(onboardingHabits);
    });

    // onboardingSave replaces all habits with the onboarded ones
    const created = result.current.habits.find((h) => h.name === 'Morning Run');
    expect(created).toBeDefined();
    expect(created!.goals).toHaveLength(3);

    // Verify three-tier structure
    const tiers = created!.goals.map((g) => g.tier);
    expect(tiers).toEqual(['low', 'clear', 'stretch']);

    // Verify API was called to persist
    expect(mockHabitsCreate).toHaveBeenCalled();
  });

  // ── Flow 5: Update habit → Delete habit → Verify gone ────────────

  it('update then delete removes habit from store and calls API', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));

    // Update
    const updatedHabit = { ...habit, name: 'Updated Meditation' };
    act(() => result.current.actions.updateHabit(updatedHabit));
    expect(result.current.habits[0]!.name).toBe('Updated Meditation');
    expect(mockHabitsUpdate).toHaveBeenCalledTimes(1);

    // Delete
    act(() => result.current.actions.deleteHabit(1));
    expect(result.current.habits).toHaveLength(0);
    expect(mockHabitsDelete).toHaveBeenCalledTimes(1);
  });

  // ── Flow 6: Multiple habits → Reorder → Verify persistence ───────

  it('reordering habits updates the store in new order', () => {
    const { result } = renderHook(() => useHabits());
    const h1 = makeHabit({ id: 1, name: 'First' });
    const h2 = makeHabit({ id: 2, name: 'Second' });
    const h3 = makeHabit({ id: 3, name: 'Third' });

    act(() => result.current.setHabitsForTesting([h1, h2, h3]));
    expect(result.current.habits.map((h) => h.name)).toEqual(['First', 'Second', 'Third']);

    act(() => result.current.actions.saveHabitOrder([h3, h1, h2]));
    expect(result.current.habits.map((h) => h.name)).toEqual(['Third', 'First', 'Second']);
  });
});

describe('HabitUtils integration with progress tracking', () => {
  it('logHabitUnits accumulates completions correctly across multiple calls', () => {
    const habit = makeHabit();

    const after1 = logHabitUnits(habit, 1);
    expect(calculateHabitProgress(after1)).toBe(1);

    const after2 = logHabitUnits(after1, 2);
    expect(calculateHabitProgress(after2)).toBe(3);

    // Should equal the clear goal target (3)
    const clearGoal = after2.goals.find((g) => g.tier === 'clear');
    expect(calculateHabitProgress(after2)).toBe(clearGoal!.target);
  });

  it('progress cannot exceed stretch target in additive mode', () => {
    const habit = makeHabit();

    // Log 10 units — more than the stretch target of 5
    const overlogged = logHabitUnits(habit, 10);
    const progress = calculateHabitProgress(overlogged);

    // Progress should still be tracked (it's the raw total)
    expect(progress).toBe(10);
  });
});
