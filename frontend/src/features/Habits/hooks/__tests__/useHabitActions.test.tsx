/**
 * Tests for `useHabitActions.logUnit` — the call site that wires
 * `habitManager` into `useOptimisticMutation`. BUG-FE-HABIT-001
 * regression coverage: on a server-rejected check-in, BOTH the store
 * and the persisted snapshot must roll back, and the milestone toast
 * must NOT fire.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../../../api', () => ({
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

jest.mock('../../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
  loadPendingCheckIns: jest.fn(() => Promise.resolve([])),
  clearPendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('../../hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(() => Promise.resolve([])),
  cancelForHabit: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly' },
}));

const mockAlert = jest.fn();
jest.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));

import { goalCompletions as goalCompletionsApi } from '../../../../api';
import { saveHabits } from '../../../../storage/habitStorage';
import { useHabitStore } from '../../../../store/useHabitStore';
import type { Habit } from '../../Habits.types';
import { useHabitActions } from '../useHabitActions';
import { useHabitUI } from '../useHabitUI';

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Meditate',
  icon: '\u{1F9D8}',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [
    {
      id: 11,
      title: 'Low',
      tier: 'low',
      target: 1,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 12,
      title: 'Clear',
      tier: 'clear',
      target: 2,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 13,
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

const renderActions = () => {
  const showToast = jest.fn();
  const { result } = renderHook(() => {
    const ui = useHabitUI();
    const actions = useHabitActions(ui, showToast);
    return { ui, actions };
  });
  return { result, showToast };
};

beforeEach(() => {
  useHabitStore.setState({ habits: [], loading: false, error: null });
  jest.clearAllMocks();
  // Defaults: API succeeds. Tests override per-case.
  (goalCompletionsApi.create as jest.Mock).mockImplementation(() =>
    Promise.resolve({ streak: 1, milestones: [], reason_code: 'ok' }),
  );
});

describe('useHabitActions.logUnit', () => {
  it('applies the optimistic update to the store and persists `next` to disk', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    const { result } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      // Let the resolved commit promise settle.
      await Promise.resolve();
    });

    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
    expect(saveHabits).toHaveBeenCalled();
    const lastCall = (saveHabits as jest.Mock).mock.calls.at(-1);
    const savedHabits = lastCall?.[0] as Habit[];
    expect(savedHabits[0]!.completions).toHaveLength(1);
  });

  it('fires a milestone toast only after the API confirms the check-in', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/Low Goal achieved/i) as unknown,
    });
  });

  it('rolls BOTH store AND disk back when the API rejects (BUG-FE-HABIT-001)', async () => {
    const habit = makeHabit();
    const initial = [habit];
    useHabitStore.setState({ habits: initial });

    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error('network down')),
    );

    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      // Let the rejected commit propagate through rollback + finally.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Store reverted: completions empty again.
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);

    // Disk reverted: the LAST persistHabits call wrote the pre-apply
    // snapshot. Before BUG-FE-HABIT-001's fix, only the store reverted
    // and AsyncStorage held the optimistic next list across launches.
    const calls = (saveHabits as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const finalSnapshot = calls.at(-1)?.[0] as Habit[];
    expect(finalSnapshot[0]!.completions).toHaveLength(0);

    // No celebration toast for a rejected check-in — onSuccess never ran.
    expect(showToast).not.toHaveBeenCalled();

    // The user sees an actionable retry prompt.
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0]?.[0]).toBe("Couldn't sync");
  });

  it('does nothing when the habit id is unknown', async () => {
    useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(999, 1);
      await Promise.resolve();
    });

    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);
    expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

// Quiet React's "unused import" concerns when `act` covers the renders.
void React;
