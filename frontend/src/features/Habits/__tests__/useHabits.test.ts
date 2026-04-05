import { describe, expect, it, jest } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import type { Goal, Habit } from '../Habits.types';
import { useHabits } from '../hooks/useHabits';

// Mock dependencies
jest.mock('../../../api', () => ({
  habits: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
    delete: jest.fn(() => Promise.resolve({})),
    getStats: jest.fn(() => Promise.resolve({})),
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
    {
      id: 2,
      title: 'Clear',
      tier: 'clear',
      target: 2,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 3,
      title: 'Stretch',
      tier: 'stretch',
      target: 3,
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

describe('useHabits', () => {
  it('exposes habits state and actions', () => {
    const { result } = renderHook(() => useHabits());

    expect(result.current.habits).toBeDefined();
    expect(result.current.loading).toBeDefined();
    expect(result.current.error).toBeDefined();
    expect(result.current.selectedHabit).toBeNull();
    expect(typeof result.current.setSelectedHabit).toBe('function');
    expect(typeof result.current.actions.updateGoal).toBe('function');
    expect(typeof result.current.actions.logUnit).toBe('function');
    expect(typeof result.current.actions.updateHabit).toBe('function');
    expect(typeof result.current.actions.deleteHabit).toBe('function');
    expect(typeof result.current.actions.saveHabitOrder).toBe('function');
    expect(typeof result.current.actions.backfillMissedDays).toBe('function');
    expect(typeof result.current.actions.setNewStartDate).toBe('function');
    expect(typeof result.current.actions.onboardingSave).toBe('function');
    expect(typeof result.current.actions.iconPress).toBe('function');
    expect(typeof result.current.actions.emojiSelect).toBe('function');
  });

  it('exposes UI flags for energy CTA and archive', () => {
    const { result } = renderHook(() => useHabits());

    expect(result.current.ui.showEnergyCTA).toBe(true);
    expect(result.current.ui.showArchiveMessage).toBe(false);
    expect(typeof result.current.ui.archiveEnergyCTA).toBe('function');
  });

  it('exposes mode state with enum values', () => {
    const { result } = renderHook(() => useHabits());

    expect(result.current.mode).toBe('normal');
    expect(typeof result.current.setMode).toBe('function');
  });

  it('setMode switches between modes', () => {
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setMode('stats'));
    expect(result.current.mode).toBe('stats');

    act(() => result.current.setMode('quickLog'));
    expect(result.current.mode).toBe('quickLog');

    act(() => result.current.setMode('edit'));
    expect(result.current.mode).toBe('edit');

    act(() => result.current.setMode('normal'));
    expect(result.current.mode).toBe('normal');
  });

  it('archiveEnergyCTA hides the CTA and shows archive message', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useHabits());

    act(() => result.current.ui.archiveEnergyCTA());
    expect(result.current.ui.showEnergyCTA).toBe(false);
    expect(result.current.ui.showArchiveMessage).toBe(true);

    act(() => jest.advanceTimersByTime(3000));
    expect(result.current.ui.showArchiveMessage).toBe(false);

    jest.useRealTimers();
  });

  it('updateGoal enforces tier hierarchy for additive goals', () => {
    const habit = makeHabit();
    const { result } = renderHook(() => useHabits());

    // Inject habit into state
    act(() => result.current.setHabitsForTesting([habit]));

    // Update low goal with target higher than clear
    const updatedGoal: Goal = {
      id: 1,
      title: 'Low',
      tier: 'low',
      target: 5,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };

    act(() => result.current.actions.updateGoal(1, updatedGoal));

    const updated = result.current.habits.find((h) => h.id === 1);
    const clearGoal = updated?.goals.find((g) => g.tier === 'clear');
    const stretchGoal = updated?.goals.find((g) => g.tier === 'stretch');

    // Clear must be >= low (5), stretch must be >= clear
    expect(clearGoal!.target).toBeGreaterThanOrEqual(5);
    expect(stretchGoal!.target).toBeGreaterThanOrEqual(clearGoal!.target);
  });

  it('deleteHabit removes habit from list', () => {
    const habit = makeHabit();
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([habit]));
    expect(result.current.habits).toHaveLength(1);

    act(() => result.current.actions.deleteHabit(1));
    expect(result.current.habits).toHaveLength(0);
  });

  it('saveHabitOrder reorders habits', () => {
    const h1 = makeHabit({ id: 1, name: 'First' });
    const h2 = makeHabit({ id: 2, name: 'Second' });
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([h1, h2]));

    act(() => result.current.actions.saveHabitOrder([h2, h1]));
    expect(result.current.habits[0]!.name).toBe('Second');
    expect(result.current.habits[1]!.name).toBe('First');
  });

  it('setNewStartDate resets habit completions and streak', () => {
    const habit = makeHabit({
      streak: 10,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
    });
    const { result } = renderHook(() => useHabits());

    act(() => result.current.setHabitsForTesting([habit]));

    const newDate = new Date('2025-06-01');
    act(() => result.current.actions.setNewStartDate(1, newDate));

    const updated = result.current.habits.find((h) => h.id === 1);
    expect(updated?.streak).toBe(0);
    expect(updated?.completions).toEqual([]);
    expect(updated?.start_date).toEqual(newDate);
  });

  it('emojiHabitIndex tracks which habit is being edited', () => {
    const { result } = renderHook(() => useHabits());

    expect(result.current.ui.emojiHabitIndex).toBeNull();
  });
});
