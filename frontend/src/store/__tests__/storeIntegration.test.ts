/**
 * Store integration tests — verify that Zustand stores work correctly
 * in concert and that cross-store operations maintain consistency.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Habit } from '../../features/Habits/Habits.types';
import { useHabitStore } from '../useHabitStore';
import { useStageStore } from '../useStageStore';
import { useUserStore } from '../useUserStore';

// Mock API dependency used by useStageStore
jest.mock('../../api', () => ({
  stages: {
    list: jest.fn(() => Promise.resolve([])),
  },
  habits: {
    list: jest.fn(() => Promise.resolve([])),
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

describe('Store Integration', () => {
  beforeEach(() => {
    useHabitStore.setState({ habits: [], loading: false, error: null });
    useStageStore.setState({ stages: [], currentStage: 1, loading: false, error: null });
    useUserStore.setState({
      preferences: { theme: 'light', notificationsEnabled: true },
    });
  });

  // ── setHabits populates store → consumers see changes ─────────────

  it('setHabits makes habits visible to all consumers', () => {
    const habit = makeHabit();

    act(() => useHabitStore.getState().setHabits([habit]));

    // First consumer
    const state1 = useHabitStore.getState();
    expect(state1.habits).toHaveLength(1);
    expect(state1.habits[0]!.name).toBe('Test Habit');

    // Second consumer sees the same data
    const state2 = useHabitStore.getState();
    expect(state2.habits).toEqual(state1.habits);
  });

  // ── updateHabit reflects in global state ──────────────────────────

  it('updateHabit propagates changes to all getState consumers', () => {
    const habit = makeHabit();
    act(() => useHabitStore.getState().setHabits([habit]));

    const updated = { ...habit, name: 'Updated Name', streak: 5 };
    act(() => useHabitStore.getState().updateHabit(updated));

    const state = useHabitStore.getState();
    expect(state.habits[0]!.name).toBe('Updated Name');
    expect(state.habits[0]!.streak).toBe(5);
  });

  // ── removeHabit + setHabits are sequentially consistent ───────────

  it('sequential add and remove operations maintain consistency', () => {
    const h1 = makeHabit({ id: 1, name: 'First' });
    const h2 = makeHabit({ id: 2, name: 'Second' });
    const h3 = makeHabit({ id: 3, name: 'Third' });

    act(() => useHabitStore.getState().setHabits([h1, h2, h3]));
    expect(useHabitStore.getState().habits).toHaveLength(3);

    act(() => useHabitStore.getState().removeHabit(2));
    expect(useHabitStore.getState().habits).toHaveLength(2);
    expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([1, 3]);

    // Add a new habit by replacing the list
    const h4 = makeHabit({ id: 4, name: 'Fourth' });
    act(() => useHabitStore.getState().setHabits([...useHabitStore.getState().habits, h4]));
    expect(useHabitStore.getState().habits).toHaveLength(3);
    expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([1, 3, 4]);
  });

  // ── Loading/error states are independent across stores ────────────

  it('habit store loading does not affect stage store loading', () => {
    act(() => useHabitStore.getState().setLoading(true));
    act(() => useStageStore.getState().setStages([]));

    expect(useHabitStore.getState().loading).toBe(true);
    expect(useStageStore.getState().loading).toBe(false);
  });

  // ── User preferences are independent from feature stores ──────────

  it('user preference updates do not affect habit or stage state', () => {
    const habit = makeHabit();
    act(() => useHabitStore.getState().setHabits([habit]));

    act(() => useUserStore.getState().updatePreferences({ theme: 'dark' }));

    expect(useUserStore.getState().preferences.theme).toBe('dark');
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(useHabitStore.getState().habits[0]!.name).toBe('Test Habit');
  });

  // ── Concurrent updates to different stores ──────────────────────��─

  it('concurrent updates to multiple stores maintain isolation', () => {
    const habit = makeHabit();

    act(() => {
      useHabitStore.getState().setHabits([habit]);
      useHabitStore.getState().setLoading(true);
      useStageStore.getState().setCurrentStage(3);
      useUserStore.getState().updatePreferences({ notificationsEnabled: false });
    });

    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(useHabitStore.getState().loading).toBe(true);
    expect(useStageStore.getState().currentStage).toBe(3);
    expect(useUserStore.getState().preferences.notificationsEnabled).toBe(false);
  });

  // ── Stage progress update is independent of habit state ───────────

  it('updating stage progress does not interfere with habits', () => {
    const habit = makeHabit();
    act(() => useHabitStore.getState().setHabits([habit]));
    act(() =>
      useStageStore.getState().setStages([
        {
          id: 1,
          title: 'Beige',
          subtitle: 'Survival',
          stageNumber: 1,
          progress: 0,
          color: '#D2B48C',
          isUnlocked: true,
          category: 'Pre-personal',
          aspect: 'Physical',
          spiralDynamicsColor: 'Beige',
          growingUpStage: 'Archaic',
          divineGenderPolarity: 'Neutral',
          relationshipToFreeWill: 'None',
          freeWillDescription: 'Instinctual',
          overviewUrl: '',
          hotspots: [],
        },
      ]),
    );

    act(() => useStageStore.getState().updateStageProgress(1, 0.5));

    expect(useStageStore.getState().stages[0]!.progress).toBe(0.5);
    expect(useHabitStore.getState().habits[0]!.name).toBe('Test Habit');
  });

  // ── Error state isolation ─────────────────────────────────────────

  it('error in one store does not propagate to others', () => {
    act(() => useHabitStore.getState().setError('Network error'));

    expect(useHabitStore.getState().error).toBe('Network error');
    expect(useStageStore.getState().error).toBeNull();
  });
});
