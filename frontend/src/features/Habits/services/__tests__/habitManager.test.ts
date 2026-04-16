import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../../api', () => ({
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

jest.mock('../../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
  savePendingCheckIn: jest.fn(() => Promise.resolve(undefined)),
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

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));

import { habits as habitsApi, goalCompletions as goalCompletionsApi } from '../../../../api';
import { saveHabits, loadHabits } from '../../../../storage/habitStorage';
import { useHabitStore } from '../../../../store/useHabitStore';
import type { Goal, Habit, OnboardingHabit } from '../../Habits.types';
import { habitManager } from '../habitManager';

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '\u{1F9D8}',
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

const resetStore = () => {
  useHabitStore.setState({ habits: [], loading: false, error: null });
};

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});

describe('habitManager', () => {
  describe('loadHabits', () => {
    it('replaces state with fallback habits when API returns empty and no cache', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().loading).toBe(false);
      expect(useHabitStore.getState().habits.length).toBeGreaterThan(0);
    });

    it('uses cached habits when available and then replaces with API data', async () => {
      const cached: Habit[] = [makeHabit({ id: 99, name: 'Cached' })];
      (loadHabits as jest.Mock).mockResolvedValueOnce(cached as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([
        {
          id: 2,
          name: 'From API',
          icon: '\u{1F680}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          notification_times: null,
          notification_frequency: null,
          notification_days: null,
          milestone_notifications: false,
        },
      ] as never);

      await habitManager.loadHabits();

      const { habits, error } = useHabitStore.getState();
      expect(error).toBeNull();
      expect(habits).toHaveLength(1);
      expect(habits[0]!.name).toBe('From API');
      expect(saveHabits).toHaveBeenCalled();
    });

    it('records an error message when the API fails and no cache exists', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.list as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();

      // Uses the shared error-message mapper in ``api/errorMessages`` —
      // unknown errors fall back to an actionable, connection-focused hint
      // rather than a generic "please try again" string.
      expect(useHabitStore.getState().error).toMatch(/couldn't load your habits/i);
    });
  });

  describe('updateGoal', () => {
    it('enforces tier hierarchy for additive goals', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const updatedLow: Goal = {
        id: 1,
        title: 'Low',
        tier: 'low',
        target: 5,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      };

      habitManager.updateGoal(1, updatedLow);

      const { goals } = useHabitStore.getState().habits[0]!;
      const clear = goals.find((g) => g.tier === 'clear')!;
      const stretch = goals.find((g) => g.tier === 'stretch')!;
      expect(clear.target).toBeGreaterThanOrEqual(5);
      expect(stretch.target).toBeGreaterThanOrEqual(clear.target);
    });
  });

  describe('updateHabit', () => {
    it('optimistically updates the store and syncs to the API', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const updated = { ...makeHabit(), name: 'Renamed' };

      habitManager.updateHabit(updated);

      expect(useHabitStore.getState().habits[0]!.name).toBe('Renamed');
      expect(habitsApi.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    it('skips the API call when the habit has no id', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const orphan = { ...makeHabit(), id: 0 };

      habitManager.updateHabit(orphan);

      expect(habitsApi.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteHabit', () => {
    it('removes the habit from the store and syncs to the API', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 }), makeHabit({ id: 2 })] });

      habitManager.deleteHabit(1);

      const { habits } = useHabitStore.getState();
      expect(habits).toHaveLength(1);
      expect(habits[0]!.id).toBe(2);
      expect(habitsApi.delete).toHaveBeenCalledWith(1);
    });
  });

  describe('saveHabitOrder', () => {
    it('replaces habits and persists to storage', () => {
      const h1 = makeHabit({ id: 1, name: 'First' });
      const h2 = makeHabit({ id: 2, name: 'Second' });
      useHabitStore.setState({ habits: [h1, h2] });

      habitManager.saveHabitOrder([h2, h1]);

      expect(useHabitStore.getState().habits.map((h) => h.name)).toEqual(['Second', 'First']);
      expect(saveHabits).toHaveBeenCalled();
    });
  });

  describe('logUnit', () => {
    it('appends a completion and returns the updated habit', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const updated = habitManager.logUnit(1, 1);

      expect(updated).not.toBeNull();
      expect(updated!.completions).toHaveLength(1);
      expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
      expect(goalCompletionsApi.create).toHaveBeenCalled();
    });

    it('invokes the toast callback when a goal tier is reached', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const showToast = jest.fn();

      habitManager.logUnit(1, 1, showToast);

      expect(showToast).toHaveBeenCalled();
    });

    it('returns null when no habit matches the id', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });

      const updated = habitManager.logUnit(999, 1);

      expect(updated).toBeNull();
    });
  });

  describe('backfillMissedDays', () => {
    it('adds backfill completions and bumps the streak', () => {
      useHabitStore.setState({ habits: [makeHabit({ streak: 2 })] });

      habitManager.backfillMissedDays(1, [new Date('2025-01-02'), new Date('2025-01-03')]);

      const habit = useHabitStore.getState().habits[0]!;
      expect(habit.streak).toBe(4);
      expect(habit.completions).toHaveLength(2);
    });
  });

  describe('setNewStartDate', () => {
    it('resets streak and completions when the start date changes', () => {
      const habit = makeHabit({
        streak: 10,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      useHabitStore.setState({ habits: [habit] });

      const newDate = new Date('2025-06-01');
      habitManager.setNewStartDate(1, newDate);

      const updated = useHabitStore.getState().habits[0]!;
      expect(updated.streak).toBe(0);
      expect(updated.completions).toEqual([]);
      expect(updated.start_date).toEqual(newDate);
    });
  });

  describe('onboardingSave', () => {
    it('builds goal tiers and calls the API for each habit', async () => {
      const newHabits: OnboardingHabit[] = [
        {
          id: 'a',
          name: 'Meditate',
          icon: '\u{1F9D8}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Beige',
          start_date: new Date('2025-01-01'),
        },
      ];
      const showToast = jest.fn();

      await habitManager.onboardingSave(newHabits, showToast);

      expect(useHabitStore.getState().habits).toHaveLength(1);
      expect(useHabitStore.getState().habits[0]!.goals).toHaveLength(3);
      expect(habitsApi.create).toHaveBeenCalled();
      expect(showToast).toHaveBeenCalled();
    });
  });

  describe('reveal helpers', () => {
    it('revealAllHabits flips every habit to revealed=true', () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, revealed: false }), makeHabit({ id: 2, revealed: false })],
      });

      habitManager.revealAllHabits();

      expect(useHabitStore.getState().habits.every((h) => h.revealed === true)).toBe(true);
    });

    it('lockUnstartedHabits reveals only habits whose start_date is in the past', () => {
      const past = new Date(Date.now() - 1000 * 60 * 60 * 24);
      const future = new Date(Date.now() + 1000 * 60 * 60 * 24);
      useHabitStore.setState({
        habits: [
          makeHabit({ id: 1, start_date: past, revealed: true }),
          makeHabit({ id: 2, start_date: future, revealed: true }),
        ],
      });

      habitManager.lockUnstartedHabits();

      const habits = useHabitStore.getState().habits;
      expect(habits[0]!.revealed).toBe(true);
      expect(habits[1]!.revealed).toBe(false);
    });

    it('unlockHabit reveals a single habit by id', () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, revealed: false }), makeHabit({ id: 2, revealed: false })],
      });

      habitManager.unlockHabit(1);

      const habits = useHabitStore.getState().habits;
      expect(habits[0]!.revealed).toBe(true);
      expect(habits[1]!.revealed).toBe(false);
    });
  });

  describe('setEmojiForHabit', () => {
    it('updates the icon of the habit at the given index', () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, icon: 'A' }), makeHabit({ id: 2, icon: 'B' })],
      });

      habitManager.setEmojiForHabit(1, '\u{2728}');

      expect(useHabitStore.getState().habits[1]!.icon).toBe('\u{2728}');
      expect(useHabitStore.getState().habits[0]!.icon).toBe('A');
    });
  });
});
