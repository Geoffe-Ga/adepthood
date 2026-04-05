/**
 * Integration tests for the Habits feature — multi-step flows that verify
 * the useHabits hook + Zustand store + HabitUtils compose correctly.
 *
 * These tests go beyond unit-level by exercising realistic user flows:
 * add habits → log units → check progress → verify tier advancement.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { Goal, Habit } from '../Habits.types';
import { calculateHabitProgress, getGoalTier, generateStatsForHabit } from '../HabitUtils';
import { useHabits } from '../hooks/useHabits';

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
}));

const makeGoals = (): Goal[] => [
  {
    id: 1,
    title: 'Low Goal',
    tier: 'low',
    target: 2,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 2,
    title: 'Clear Goal',
    tier: 'clear',
    target: 5,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 3,
    title: 'Stretch Goal',
    tier: 'stretch',
    target: 10,
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

describe('Habits integration flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { useHabitStore } = require('../../../store/useHabitStore');
    useHabitStore.setState({ habits: [], loading: false, error: null });
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 1: Populate → Log units → Progress bar updates → Tier advances
  // ────────────────────────────────────────────────────────────────────

  it('logging units advances progress through goal tiers', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));

    // Log 2 units → should reach low goal (target=2)
    act(() => result.current.actions.logUnit(1, 2));

    let current = result.current.habits.find((h) => h.id === 1)!;
    let progress = calculateHabitProgress(current);
    expect(progress).toBe(2);

    let tier = getGoalTier(current);
    expect(tier.currentGoal.tier).toBe('low');

    // Log 3 more units → total 5, should reach clear goal (target=5)
    act(() => result.current.actions.logUnit(1, 3));

    current = result.current.habits.find((h) => h.id === 1)!;
    progress = calculateHabitProgress(current);
    expect(progress).toBe(5);

    tier = getGoalTier(current);
    expect(tier.currentGoal.tier).toBe('clear');
    expect(tier.nextGoal?.tier).toBe('stretch');

    // Log 5 more → total 10, should reach stretch goal (target=10)
    act(() => result.current.actions.logUnit(1, 5));

    current = result.current.habits.find((h) => h.id === 1)!;
    progress = calculateHabitProgress(current);
    expect(progress).toBe(10);

    tier = getGoalTier(current);
    expect(tier.completedAllGoals).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 2: Quick log mode — log without modal, progress updates
  // ────────────────────────────────────────────────────────────────────

  it('quick log mode logs single units and tracks completions', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));
    act(() => result.current.setMode('quickLog'));
    expect(result.current.mode).toBe('quickLog');

    // Simulate quick-log taps (each logs 1 unit)
    act(() => result.current.actions.logUnit(1, 1));
    act(() => result.current.actions.logUnit(1, 1));

    const current = result.current.habits.find((h) => h.id === 1)!;
    expect(calculateHabitProgress(current)).toBe(2);
    expect(current.completions).toHaveLength(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 3: Update goal → tier hierarchy enforced across all goals
  // ────────────────────────────────────────────────────────────────────

  it('updating a goal enforces tier ordering and shared unit consistency', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));

    // Raise the low goal target above the clear target (5)
    const raisedLow: Goal = {
      id: 1,
      title: 'Low Goal',
      tier: 'low',
      target: 7,
      target_unit: 'reps',
      frequency: 2,
      frequency_unit: 'per_week',
      is_additive: true,
    };
    act(() => result.current.actions.updateGoal(1, raisedLow));

    const updated = result.current.habits.find((h) => h.id === 1)!;
    const low = updated.goals.find((g) => g.tier === 'low')!;
    const clear = updated.goals.find((g) => g.tier === 'clear')!;
    const stretch = updated.goals.find((g) => g.tier === 'stretch')!;

    // Tier hierarchy: low ≤ clear ≤ stretch for additive goals
    expect(clear.target).toBeGreaterThanOrEqual(low.target);
    expect(stretch.target).toBeGreaterThanOrEqual(clear.target);

    // All goals should share the updated unit and frequency
    expect(clear.target_unit).toBe('reps');
    expect(stretch.target_unit).toBe('reps');
    expect(clear.frequency_unit).toBe('per_week');
    expect(stretch.frequency_unit).toBe('per_week');
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 4: Stats generation from completions
  // ────────────────────────────────────────────────────────────────────

  it('stats reflect real completion data after logging', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit();

    act(() => result.current.setHabitsForTesting([habit]));

    // Log multiple units
    act(() => result.current.actions.logUnit(1, 3));
    act(() => result.current.actions.logUnit(1, 2));

    const current = result.current.habits.find((h) => h.id === 1)!;
    const stats = generateStatsForHabit(current);

    expect(stats.totalCompletions).toBe(2);
    expect(stats.longestStreak).toBeGreaterThanOrEqual(1);
    // Values array should have at least one non-zero day
    const totalUnitsLogged = stats.values.reduce((a, b) => a + b, 0);
    expect(totalUnitsLogged).toBe(5);
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 5: Backfill missed days increases streak
  // ────────────────────────────────────────────────────────────────────

  it('backfilling missed days increases streak count', () => {
    const { result } = renderHook(() => useHabits());
    const habit = makeHabit({ streak: 3 });

    act(() => result.current.setHabitsForTesting([habit]));

    const missedDays = [new Date('2025-01-05'), new Date('2025-01-06')];
    act(() => result.current.actions.backfillMissedDays(1, missedDays));

    const current = result.current.habits.find((h) => h.id === 1)!;
    expect(current.streak).toBe(5); // 3 + 2 backfilled
    expect(current.completions).toHaveLength(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // Flow 6: Delete habit removes it completely
  // ────────────────────────────────────────────────────────────────────

  it('deleting a habit from multiple removes only that habit', () => {
    const { result } = renderHook(() => useHabits());

    const habits = [
      makeHabit({ id: 1, name: 'Keep' }),
      makeHabit({ id: 2, name: 'Delete Me' }),
      makeHabit({ id: 3, name: 'Also Keep' }),
    ];
    act(() => result.current.setHabitsForTesting(habits));
    expect(result.current.habits).toHaveLength(3);

    act(() => result.current.actions.deleteHabit(2));

    expect(result.current.habits).toHaveLength(2);
    expect(result.current.habits.map((h) => h.name)).toEqual(['Keep', 'Also Keep']);
  });
});
