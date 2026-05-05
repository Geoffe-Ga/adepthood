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
  goals: {
    update: jest.fn(() => Promise.resolve({})),
  },
}));

jest.mock('../../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
  savePendingCheckIn: jest.fn(() => Promise.resolve(undefined)),
  loadPendingCheckIns: jest.fn(() => Promise.resolve([])),
  clearPendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
  replacePendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
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

import {
  habits as habitsApi,
  goalCompletions as goalCompletionsApi,
  goals as goalsApi,
} from '../../../../api';
import {
  saveHabits,
  loadHabits,
  loadPendingCheckIns,
  clearPendingCheckIns,
  replacePendingCheckIns,
} from '../../../../storage/habitStorage';
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

    it('does NOT seed FALLBACK_HABITS when the live store already has habits', async () => {
      // Cache empty + API empty + live store has habits → leave them alone.
      const userBuilt: Habit[] = [makeHabit({ id: 1, name: 'My Habit' })];
      useHabitStore.setState({ habits: userBuilt });
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.name).toBe('My Habit');
    });

    it('does NOT seed FALLBACK_HABITS when the live store has habits and the API throws', async () => {
      // Symmetric guard for ``handleApiError`` — same invariant as above.
      const userBuilt: Habit[] = [makeHabit({ id: 1, name: 'My Habit' })];
      useHabitStore.setState({ habits: userBuilt });
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.list as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();

      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.name).toBe('My Habit');
    });

    it('recovers stuck users by pushing cached habits when the server has none', async () => {
      // Stuck-user state: the user's original onboarding sync silently
      // failed long ago (e.g. against the broken pre-#280 schema), so the
      // cache holds habits with synthetic ids while the server has zero
      // habits. Without recovery, every log POST 404s forever — the
      // server has nothing to match the synthetic ``goal_id`` against.
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      // First GET: empty (stuck state). Second GET (after recovery push):
      // the habit re-appears with its newly-assigned server id.
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
        {
          id: 99,
          name: 'Pranayama',
          icon: cachedHabit.icon,
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      // The recovery push went out for the stuck habit.
      expect(habitsApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pranayama' }));
      // And the store now reflects the server's real autoincrement id.
      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(99);
    });

    it('does NOT push cached habits when the server already has habits', async () => {
      // Sanity check: ordinary "API has my habits" path must not retrigger
      // the recovery push — that would create duplicates server-side.
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([
        {
          id: 99,
          name: 'Pranayama',
          icon: cachedHabit.icon,
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(habitsApi.create).not.toHaveBeenCalled();
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

    it('replays the full queue and clears it when every check-in posts', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        { goal_id: 1, did_complete: true, timestamp: '2025-04-01T00:00:00Z' },
        { goal_id: 2, did_complete: true, timestamp: '2025-04-02T00:00:00Z' },
      ] as never);

      await habitManager.loadHabits();

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(2);
      expect(clearPendingCheckIns).toHaveBeenCalled();
      expect(replacePendingCheckIns).not.toHaveBeenCalled();
    });

    it('keeps only the unprocessed suffix when replay fails mid-batch (BUG-FE-HABIT-205)', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        { goal_id: 1, did_complete: true, timestamp: '2025-04-01T00:00:00Z' },
        { goal_id: 2, did_complete: true, timestamp: '2025-04-02T00:00:00Z' },
        { goal_id: 3, did_complete: true, timestamp: '2025-04-03T00:00:00Z' },
      ] as never);
      // First call succeeds, second rejects. Without the fix, the
      // successful prefix stays queued and reposts on next replay,
      // duplicating the user's streak.
      (goalCompletionsApi.create as jest.Mock)
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(new Error('still offline') as never);

      await habitManager.loadHabits();

      expect(clearPendingCheckIns).not.toHaveBeenCalled();
      expect(replacePendingCheckIns).toHaveBeenCalledWith([
        { goal_id: 2, did_complete: true, timestamp: '2025-04-02T00:00:00Z' },
        { goal_id: 3, did_complete: true, timestamp: '2025-04-03T00:00:00Z' },
      ]);
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

    it('PUTs the goal change to /goals/{id} so edits survive the next load', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const updatedLow: Goal = {
        id: 1,
        title: 'Low',
        tier: 'low',
        target: 7,
        target_unit: 'glasses',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      };

      habitManager.updateGoal(1, updatedLow);
      await Promise.resolve();

      expect(goalsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ target: 7 }));
    });

    it('rolls the store back when the API rejects the goal update', async () => {
      const original = makeHabit();
      const baseline = [original];
      useHabitStore.setState({ habits: baseline });
      (goalsApi.update as jest.Mock).mockRejectedValueOnce(new Error('server down') as never);

      const edited: Goal = {
        ...original.goals.find((g) => g.tier === 'low')!,
        target: 99,
      };

      habitManager.updateGoal(1, edited);
      // Optimistic write lands first.
      expect(useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'low')!.target).toBe(
        99,
      );
      await Promise.resolve();
      await Promise.resolve();

      // Rollback restores the baseline target.
      expect(useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'low')!.target).toBe(
        1,
      );
    });

    it('skips the network call for synthetic goals with no id', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const synthetic: Goal = {
        // Intentionally omit ``id`` to mimic an unsynced cache entry.
        title: 'Low',
        tier: 'low',
        target: 7,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      } as unknown as Goal;

      habitManager.updateGoal(1, synthetic);
      await Promise.resolve();

      expect(goalsApi.update).not.toHaveBeenCalled();
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
    it('replaces habits, stamps sort_order, persists, and syncs each row to the API', () => {
      const h1 = makeHabit({ id: 1, name: 'First' });
      const h2 = makeHabit({ id: 2, name: 'Second' });
      useHabitStore.setState({ habits: [h1, h2] });

      habitManager.saveHabitOrder([h2, h1]);

      const stored = useHabitStore.getState().habits;
      expect(stored.map((h) => h.name)).toEqual(['Second', 'First']);
      expect(stored.map((h) => h.sort_order)).toEqual([0, 1]);
      expect(saveHabits).toHaveBeenCalled();
      expect(habitsApi.update).toHaveBeenCalledWith(2, expect.objectContaining({ sort_order: 0 }));
      expect(habitsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ sort_order: 1 }));
    });
  });

  describe('logUnit primitives (apply / commit / rollback)', () => {
    it('prepareLogUnit + applyLogUnitContext appends a completion and returns the updated habit', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const ctx = habitManager.prepareLogUnit(1, 1);
      expect(ctx).not.toBeNull();
      habitManager.applyLogUnitContext(ctx!);

      expect(ctx!.updated.completions).toHaveLength(1);
      expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
    });

    it('commitLogUnitContext POSTs the goal completion to the API', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const ctx = habitManager.prepareLogUnit(1, 1)!;
      habitManager.applyLogUnitContext(ctx);

      await habitManager.commitLogUnitContext(ctx);

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: ctx.currentGoal.id,
        did_complete: true,
      });
    });

    it('buildLogUnitToast returns a milestone config when a tier is reached', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const ctx = habitManager.prepareLogUnit(1, 1)!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast).not.toBeNull();
      expect(toast!.message).toMatch(/Low Goal achieved/i);
    });

    it('buildLogUnitToast returns a confirmation toast when no milestone fires', () => {
      // Without this, ``logUnit`` could complete with no visible feedback at
      // all when the user added units that did not cross a tier threshold —
      // matching the user-reported "logging units is doing nothing" symptom.
      // The progress-bar redraw is too subtle to register as feedback on
      // mobile, so every successful log now surfaces an explicit toast.
      useHabitStore.setState({
        habits: [
          makeHabit({
            completions: [{ id: 'pre', timestamp: new Date(), completed_units: 5 }],
          }),
        ],
      });
      const ctx = habitManager.prepareLogUnit(1, 1)!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast).not.toBeNull();
      expect(toast!.message).toMatch(/logged/i);
    });

    it('rollbackLogUnitContext restores both the store AND the persisted snapshot', () => {
      const habit = makeHabit();
      const prev = [habit];
      useHabitStore.setState({ habits: prev });

      const ctx = habitManager.prepareLogUnit(1, 1)!;
      habitManager.applyLogUnitContext(ctx);
      expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);

      habitManager.rollbackLogUnitContext(ctx);

      // Store reverted.
      expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(0);
      // Disk reverted — saveHabits called with the pre-apply snapshot, not
      // the optimistic next list. This is the BUG-FE-HABIT-001 regression
      // guard: before the fix, only the store reverted while AsyncStorage
      // held the optimistic state and rehydrated stale on next launch.
      expect(saveHabits).toHaveBeenLastCalledWith(prev);
    });

    it('prepareLogUnit returns null when no habit matches the id', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });

      const ctx = habitManager.prepareLogUnit(999, 1);

      expect(ctx).toBeNull();
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

    it('refreshes habits from the server after sync so local IDs match the wire', async () => {
      // Synthetic onboarding IDs would otherwise stay in the store while the
      // server has its real autoincrement IDs — every log POST then 404s.
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
      // Server returns the habit with a real autoincrement id (47), real
      // goal ids (101/102/103), and the same name we POSTed.
      (habitsApi.list as jest.Mock).mockResolvedValueOnce([
        {
          id: 47,
          name: 'Meditate',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [
            {
              id: 101,
              habit_id: 47,
              title: 'Low',
              tier: 'low',
              target: 1,
              target_unit: 'units',
              frequency: 1,
              frequency_unit: 'per_day',
              is_additive: true,
            },
            {
              id: 102,
              habit_id: 47,
              title: 'Clear',
              tier: 'clear',
              target: 2,
              target_unit: 'units',
              frequency: 1,
              frequency_unit: 'per_day',
              is_additive: true,
            },
            {
              id: 103,
              habit_id: 47,
              title: 'Stretch',
              tier: 'stretch',
              target: 3,
              target_unit: 'units',
              frequency: 1,
              frequency_unit: 'per_day',
              is_additive: true,
            },
          ],
        },
      ] as never);

      await habitManager.onboardingSave(newHabits, jest.fn());

      // Store now reflects the server's IDs, not the synthetic ones.
      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(47);
      expect(stored[0]!.goals.map((g) => g.id)).toEqual([101, 102, 103]);
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
    it('updates the icon of the habit at the given index and syncs to the API', () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, icon: 'A' }), makeHabit({ id: 2, icon: 'B' })],
      });

      habitManager.setEmojiForHabit(1, '\u{2728}');

      expect(useHabitStore.getState().habits[1]!.icon).toBe('\u{2728}');
      expect(useHabitStore.getState().habits[0]!.icon).toBe('A');
      expect(habitsApi.update).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ icon: '\u{2728}' }),
      );
    });

    it('does nothing when the index is out of range', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, icon: 'A' })] });

      habitManager.setEmojiForHabit(7, '\u{2728}');

      expect(useHabitStore.getState().habits[0]!.icon).toBe('A');
      expect(habitsApi.update).not.toHaveBeenCalled();
    });
  });
});
