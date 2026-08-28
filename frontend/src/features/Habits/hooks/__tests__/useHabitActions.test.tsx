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

jest.mock('../../../../api', () => {
  class MockApiError extends Error {
    status: number;
    detail: string;
    constructor(status: number, detail: string) {
      super(`Request failed with status ${status}: ${detail}`);
      this.name = 'ApiError';
      this.status = status;
      this.detail = detail;
    }
  }
  class MockApiValidationError extends Error {
    constructor() {
      super('validation failed');
      this.name = 'ApiValidationError';
    }
  }
  return {
    ApiError: MockApiError,
    ApiValidationError: MockApiValidationError,
    habits: {
      listAll: jest.fn(() => Promise.resolve([])),
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
      delete: jest.fn(() => Promise.resolve({})),
    },
    goalCompletions: {
      create: jest.fn(() => Promise.resolve({ streak: 1, milestones: [], reason_code: 'ok' })),
    },
    goals: {
      update: jest.fn(() => Promise.resolve({})),
    },
    // useHabitUI hydrates the energy-CTA flag server-first via uiFlags.get.
    uiFlags: {
      get: jest.fn(() => Promise.reject(new Error('no server hydration configured'))),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
});

jest.mock('../../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
  loadPendingCheckIns: jest.fn(() => Promise.resolve([])),
  clearPendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
  savePendingCheckIn: jest.fn(() => Promise.resolve(undefined)),
  recordDroppedCheckIn: jest.fn(() => Promise.resolve(undefined)),
  loadDroppedCheckIns: jest.fn(() => Promise.resolve([])),
  clearDroppedCheckIns: jest.fn(() => Promise.resolve(undefined)),
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

import {
  ApiError as MockApiError,
  ApiValidationError as MockApiValidationError,
  goalCompletions as goalCompletionsApi,
  habits as habitsApi,
} from '../../../../api';
import { colors } from '../../../../design/tokens';
import { saveHabits, savePendingCheckIn } from '../../../../storage/habitStorage';
import { useHabitStore } from '../../../../store/useHabitStore';
import type { Habit } from '../../Habits.types';
import { habitManager } from '../../services/habitManager';
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

/** An onboarding scaffold row: positive, plausible ids that only this device knows. */
const makeScaffoldHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({ hasClientMintedIds: true, ...overrides });

const renderActions = () => {
  const showToast = jest.fn();
  const { result } = renderHook(() => {
    const ui = useHabitUI();
    const actions = useHabitActions(ui, showToast, 'UTC');
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

  it('auto-resyncs habits when a check-in 404s with goal_not_found (#282)', async () => {
    // The stale-synthetic-ID symptom: onboarding POSTs succeeded but the
    // trailing GET failed, so the store still holds synthetic goal ids
    // the server has never heard of.
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new MockApiError(404, 'goal_not_found')),
    );
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    // One background refresh re-fetches the server's authoritative ids…
    expect(habitsApi.listAll).toHaveBeenCalledTimes(1);
    // …and the toast tells the user to simply tap again.
    expect(showToast.mock.calls.at(-1)?.[0]).toMatchObject({
      message: expect.stringMatching(/refreshed/i) as unknown,
    });
  });

  it('does NOT resync habits on unrelated check-in failures (#282)', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(
        new (MockApiError as unknown as new (s: number, d: string) => Error)(500, 'internal_error'),
      ),
    );
    const { result } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(habitsApi.listAll).not.toHaveBeenCalled();
  });

  it('rolls BOTH store AND disk back when the API rejects (BUG-FE-HABIT-001)', async () => {
    const habit = makeHabit();
    const initial = [habit];
    useHabitStore.setState({ habits: initial });

    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(
        new (MockApiError as unknown as new (s: number, d: string) => Error)(422, 'nope'),
      ),
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

    // The user sees an actionable retry prompt — surfaced via the
    // ToastProvider so it renders on React Native Web mobile browsers.
    // ``Alert.alert`` was previously the only feedback path and reduced
    // to a no-op on mobile web, leaving the user with a brief "flash and
    // nothing" — exactly the symptom reported.
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/couldn'?t (save|sync)/i) as unknown,
    });
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

describe('useHabitActions.logUnit offline queueing (issue #415)', () => {
  it('queues the check-in and keeps the optimistic state on a network error', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePendingCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ goal_id: 11, did_complete: true, completed_on: undefined }),
    );
    // Optimistic state survives — the tap is queued, not thrown away.
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
    const messages = (showToast as jest.Mock).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(messages.some((m) => /sync when you reconnect/i.test(m))).toBe(true);
  });

  it('forwards the backfill day when a backdated log goes offline', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const { result } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1, new Date('2025-06-01T12:00:00Z'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePendingCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ goal_id: 11, completed_on: '2025-06-01' }),
    );
  });

  it('does NOT queue on ApiValidationError — reverts instead', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new (MockApiValidationError as unknown as new () => Error)()),
    );
    const { result } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePendingCheckIn).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);
  });

  it('does NOT queue on a server rejection — reverts instead', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(
        new (MockApiError as unknown as new (s: number, d: string) => Error)(422, 'nope'),
      ),
    );
    const { result } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePendingCheckIn).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);
  });

  it('never queues a demo-seed tile and never promises it will sync later', async () => {
    // A demo tile's goal id is client-fabricated, so no POST leaves and nothing can be queued.
    useHabitStore.setState({ habits: [makeHabit({ isDemoSeed: true })] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    expect(savePendingCheckIn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { message: string; color?: string };
    expect(toast.message.length).toBeGreaterThan(0);
    expect(toast.message).not.toMatch(/sync when you reconnect/i);
    expect(toast.color).toBe(colors.secondary);
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
  });
});

describe('useHabitActions.logUnit on a demo-seed tile while online', () => {
  it('explains the sample tile instead of blaming a sync problem', async () => {
    // A demo tile is seeded on a fresh account WITH a connection too. Its
    // fabricated goal id never reaches the wire, so nothing about the tap
    // should read as a sync problem the user could act on.
    useHabitStore.setState({ habits: [makeHabit({ isDemoSeed: true })] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { message: string; color?: string };
    expect(toast.color).toBe(colors.secondary);
    expect(toast.message).not.toMatch(/out of sync/i);
    // Nothing is queued, and no futile refresh fires.
    expect(savePendingCheckIn).not.toHaveBeenCalled();
    expect(habitsApi.listAll).not.toHaveBeenCalled();
    // The optimistic increment stays: the sample tile remains explorable.
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
  });

  it('shows the sample-tile notice and never an unearned celebration', async () => {
    useHabitStore.setState({ habits: [makeHabit({ isDemoSeed: true })] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { message: string; color?: string };
    expect(toast.message).toMatch(/sample habits/i);
    expect(toast.message).not.toMatch(/Goal achieved/i);
    expect(toast.message).not.toMatch(/sync when you reconnect/i);
    expect(toast.color).toBe(colors.secondary);
  });

  it('still POSTs once and celebrates for a server-backed tile beside the demo seed', async () => {
    // Goal id 91 belongs only to the real row, so the assertion cannot pass by coincidence.
    const real = makeHabit({ id: 42, name: 'Real' });
    real.goals = real.goals.map((g, i) => ({ ...g, id: 91 + i }));
    useHabitStore.setState({ habits: [makeHabit({ isDemoSeed: true, id: 3 }), real] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(42, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goalCompletionsApi.create).toHaveBeenCalledTimes(1);
    expect(goalCompletionsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ goal_id: 91, did_complete: true }),
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/Low Goal achieved/i) as unknown,
    });
  });
});

describe('useHabitActions.logUnit on a client-minted scaffold tile', () => {
  const toastMessages = (showToast: jest.Mock): string[] =>
    showToast.mock.calls.map((c) => (c[0] as { message: string }).message);

  it('resyncs in the background instead of posting an id the server never issued', async () => {
    useHabitStore.setState({ habits: [makeScaffoldHabit()] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    expect(habitsApi.listAll).toHaveBeenCalledTimes(1);
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);
    expect(toastMessages(showToast).some((m) => /sync when you reconnect/i.test(m))).toBe(false);
  });

  it('says the habit has not finished saving and to try again', async () => {
    useHabitStore.setState({ habits: [makeScaffoldHabit()] });
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    const message = toastMessages(showToast).at(-1)!;
    expect(message).toMatch(/finish(ed)? saving/i);
    expect(message).toMatch(/again/i);
  });

  it('never queues the check-in and never promises it will sync later', async () => {
    useHabitStore.setState({ habits: [makeScaffoldHabit()] });
    (goalCompletionsApi.create as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const { result, showToast } = renderActions();

    await act(async () => {
      result.current.actions.logUnit(1, 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    expect(savePendingCheckIn).not.toHaveBeenCalled();
    expect(toastMessages(showToast).some((m) => /sync when you reconnect/i.test(m))).toBe(false);
  });

  it('does not queue even when a raw network error reaches the failure handler', async () => {
    useHabitStore.setState({ habits: [makeScaffoldHabit()] });
    const commitSpy = jest
      .spyOn(habitManager, 'commitLogUnitContext')
      .mockRejectedValue(new TypeError('fetch failed'));
    try {
      const { result } = renderActions();

      await act(async () => {
        result.current.actions.logUnit(1, 1);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(savePendingCheckIn).not.toHaveBeenCalled();
    } finally {
      commitSpy.mockRestore();
    }
  });
});

describe('useHabitActions.addHabit', () => {
  it('forwards to the manager and POSTs the new habit to /habits/', async () => {
    useHabitStore.setState({ habits: [] });
    const { result } = renderActions();

    await act(async () => {
      await result.current.actions.addHabit({ name: 'Brand New', icon: '🆕' });
    });

    expect(habitsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Brand New', icon: '🆕' }),
    );
  });
});

describe('useHabitActions tz binding for date-shifted mutations', () => {
  it('forwards the hook tz prop as the third argument to backfillMissedDays', () => {
    // Spy before render: useMemo captures whatever habitManager.backfillMissedDays
    // currently is, so the spy must already be in place at capture time.
    const backfillSpy = jest.spyOn(habitManager, 'backfillMissedDays').mockImplementation(() => {});
    const { result } = renderActions();
    const days = [new Date('2025-01-02')];

    act(() => {
      result.current.actions.backfillMissedDays(1, days);
    });

    expect(backfillSpy).toHaveBeenCalledWith(1, days, 'UTC');
    backfillSpy.mockRestore();
  });
});

describe('useHabitActions — referential stability', () => {
  let stableShowToast: jest.Mock;

  beforeEach(() => {
    stableShowToast = jest.fn();
  });

  const renderActionsStable = () =>
    renderHook(() => {
      const ui = useHabitUI();
      const actions = useHabitActions(ui, stableShowToast, 'UTC');
      return { ui, actions };
    });

  it('keeps the same actions reference across an unrelated re-render', async () => {
    const { result, rerender } = renderActionsStable();
    await act(async () => {
      await Promise.resolve();
    });

    const first = result.current.actions;
    rerender({});

    expect(result.current.actions).toBe(first);
  });

  it('keeps the same actions reference when emojiHabitIndex changes', async () => {
    const { result } = renderActionsStable();
    await act(async () => {
      await Promise.resolve();
    });

    const first = result.current.actions;
    act(() => {
      result.current.actions.iconPress(0);
    });

    expect(result.current.actions).toBe(first);
  });

  it('emojiSelect commits against the emoji-picker target set on a later render', async () => {
    useHabitStore.setState({ habits: [makeHabit()] });
    const { result } = renderActionsStable();
    await act(async () => {
      await Promise.resolve();
    });

    const emojiSelect = result.current.actions.emojiSelect;
    act(() => {
      result.current.actions.iconPress(0);
    });
    act(() => {
      emojiSelect('X');
    });

    expect(useHabitStore.getState().habits[0]!.icon).toBe('X');
    expect(result.current.ui.emojiHabitIndex).toBeNull();
  });

  it('keeps logUnit and onboardingSave stable across a re-render', async () => {
    const { result, rerender } = renderActionsStable();
    await act(async () => {
      await Promise.resolve();
    });

    const { logUnit, onboardingSave } = result.current.actions;
    rerender({});

    expect(result.current.actions.logUnit).toBe(logUnit);
    expect(result.current.actions.onboardingSave).toBe(onboardingSave);
  });
});

// Quiet React's "unused import" concerns when `act` covers the renders.
void React;
