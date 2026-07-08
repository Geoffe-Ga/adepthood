import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Keep the real ``toLocalHabit`` mapper (the load path now delegates to it and
// these tests assert its tier/notification sanitizing) while stubbing only the
// network namespaces habitManager calls.
jest.mock('../../../../api', () => ({
  ...jest.requireActual<typeof ApiModule>('../../../../api'),
  habits: {
    listAll: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
    delete: jest.fn(() => Promise.resolve({})),
    getStats: jest.fn(() => Promise.resolve({})),
    updateGoalUnits: jest.fn(() => Promise.resolve([])),
  },
  goalCompletions: {
    create: jest.fn(() => Promise.resolve({})),
  },
  goals: {
    update: jest.fn(() => Promise.resolve({})),
  },
  goalGroups: {
    list: jest.fn(() => Promise.resolve([])),
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

import type * as ApiModule from '../../../../api';
import {
  habits as habitsApi,
  goalCompletions as goalCompletionsApi,
  goalGroups as goalGroupsApi,
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
import { useProgramStore } from '../../../../store/useProgramStore';
import { dayKeyInTZ } from '../../../../utils/dateUtils';
import type { Goal, Habit, OnboardingHabit } from '../../Habits.types';
import { applyGoalUpdate, habitManager } from '../habitManager';

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

/** Server-default goal shape returned by the post-recovery re-fetch (#286 tests). */
const freshServerGoal = (id: number, title: string, tier: string, target: number) => ({
  id,
  title,
  tier,
  target,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
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
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().loading).toBe(false);
      expect(useHabitStore.getState().habits.length).toBeGreaterThan(0);
    });

    it('FALLBACK_HABITS (offline demo seed) stay unlocked so the degraded state is interactable', async () => {
      // The locked-by-default rule targets real onboarding-seeded and
      // user-created habits. FALLBACK_HABITS is a placeholder demo shown only
      // when the server is unreachable and no cache exists; locking it would
      // render every tile behind the padlock during an outage, with no real
      // data to unlock. It stays revealed so the offline demo remains usable.
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      const habits = useHabitStore.getState().habits;
      expect(habits.length).toBeGreaterThan(0);
      expect(habits.every((h) => h.revealed === true)).toBe(true);
    });

    it('mapApiHabits reads the revealed flag from the API response instead of hardcoding true', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 5,
          name: 'Stretch',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          revealed: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits[0]!.revealed).toBe(false);
    });

    it('does NOT seed FALLBACK_HABITS when the live store already has habits', async () => {
      // Cache empty + API empty + live store has habits → leave them alone.
      const userBuilt: Habit[] = [makeHabit({ id: 1, name: 'My Habit' })];
      useHabitStore.setState({ habits: userBuilt });
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

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
      (habitsApi.listAll as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();

      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.name).toBe('My Habit');
    });

    it('replays cached goal customizations after stuck-user recovery (#286)', async () => {
      // The cached clear goal carries a user customization (30 minutes)
      // that never reached the server before the stuck state began.
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, target: 30, target_unit: 'minutes' } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      // Only the customized goal is replayed — defaults that already match
      // the server are not re-PUT.
      expect(goalsApi.update).toHaveBeenCalledTimes(1);
      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ tier: 'clear', target: 30, target_unit: 'minutes' }),
      );
      // And the user sees their customization immediately, not the default.
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.target).toBe(30);
      expect(clear.target_unit).toBe('minutes');
    });

    it('replays days_of_week customizations after recovery (#426)', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, days_of_week: ['Mon', 'Wed'] } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ days_of_week: ['Mon', 'Wed'] }),
      );
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.days_of_week).toEqual(['Mon', 'Wed']);
    });

    it('restores a surviving goal-group association during replay (#425)', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, target: 30, goal_group_id: 5 } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (goalGroupsApi.list as jest.Mock).mockResolvedValueOnce([
        { id: 5, name: 'Morning Flow' },
      ] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ goal_group_id: 5 }),
      );
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.goal_group_id).toBe(5);
    });

    it('drops a goal-group id the server no longer knows (#425)', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, target: 30, goal_group_id: 7 } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (goalGroupsApi.list as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ goal_group_id: null }),
      );
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.goal_group_id ?? null).toBeNull();
    });

    it('replays goal fields even when the goal-group list is unavailable (#425)', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, target: 30, goal_group_id: 5 } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (goalGroupsApi.list as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      // The target customization still replays; the unverifiable
      // association is dropped rather than failing the recovery.
      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ target: 30, goal_group_id: null }),
      );
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.target).toBe(30);
    });

    it('one failed replay PUT does not abort the remaining goals (#286)', async () => {
      // Both clear AND stretch carry customizations; the clear PUT fails.
      // Best-effort-per-goal is the core design choice: stretch must still
      // replay, and the store must keep the server default for clear only.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) => {
        if (g.tier === 'clear') return { ...g, target: 30, target_unit: 'minutes' };
        if (g.tier === 'stretch') return { ...g, target: 40, target_unit: 'minutes' };
        return g;
      });
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);
      (goalsApi.update as jest.Mock)
        .mockRejectedValueOnce(new Error('server hiccup') as never)
        .mockResolvedValueOnce({} as never);

      await habitManager.loadHabits();

      // The clear failure did not abort the stretch replay.
      expect(goalsApi.update).toHaveBeenCalledTimes(2);
      const goals = useHabitStore.getState().habits[0]!.goals;
      const clear = goals.find((g) => g.tier === 'clear')!;
      const stretch = goals.find((g) => g.tier === 'stretch')!;
      // Stretch (accepted) shows the customization; clear (rejected) keeps
      // the server default rather than lying about unsaved state.
      expect(stretch.target).toBe(40);
      expect(stretch.target_unit).toBe('minutes');
      expect(clear.target).toBe(2);
      expect(clear.target_unit).toBe('units');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
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
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
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
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 2,
          name: 'From API',
          icon: '\u{1F680}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          notification_times: null,
          notification_frequency: null,
          notification_days: null,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      const { habits, error } = useHabitStore.getState();
      expect(error).toBeNull();
      expect(habits).toHaveLength(1);
      expect(habits[0]!.name).toBe('From API');
      expect(saveHabits).toHaveBeenCalled();
    });

    it('re-anchors the universal program calendar to the earliest loaded habit start_date', async () => {
      // Returning user: cache empty, the master anchor was wiped on logout,
      // but the server still has the user's habits. The Habits screen derives
      // each tile from its own ``start_date`` so it keeps progressing, but
      // Map/Practice/Course/Journal read the program anchor — which only
      // ``onboardingSave`` ever set. Without a reload-time re-sync the anchor
      // stays null and those screens silently fall back to divergent values.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 1,
          name: 'Survive',
          icon: '\u{1F9D8}',
          start_date: '2026-01-08',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
        {
          id: 2,
          name: 'Belong',
          icon: '\u{1F49C}',
          start_date: '2026-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Purple',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      const anchor = useProgramStore.getState().programStartDate;
      expect(anchor).not.toBeNull();
      expect(anchor!.getFullYear()).toBe(2026);
      expect(anchor!.getMonth()).toBe(0);
      expect(anchor!.getDate()).toBe(1);
    });

    it('does NOT anchor the program calendar to the demo FALLBACK habits', async () => {
      // Truly-fresh user: no cache, empty server. ``loadHabits`` seeds the
      // hard-coded demo tiles (2025 dates) so the screen is not blank — but
      // those are placeholders, not a real program start, so the master
      // anchor must stay null and let every screen use its server fallback.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits.length).toBeGreaterThan(0);
      expect(useProgramStore.getState().programStartDate).toBeNull();
    });

    it('records an error message when the API fails and no cache exists', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();

      // Uses the shared error-message mapper in ``api/errorMessages`` —
      // unknown errors fall back to an actionable, connection-focused hint
      // rather than a generic "please try again" string.
      expect(useHabitStore.getState().error).toMatch(/couldn't load your habits/i);
    });

    it('replays the full queue and clears it when every check-in posts', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        { goal_id: 1, did_complete: true, timestamp: '2025-04-01T00:00:00Z' },
        { goal_id: 2, did_complete: true, timestamp: '2025-04-02T00:00:00Z' },
      ] as never);

      await habitManager.loadHabits();

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(2);
      expect(clearPendingCheckIns).toHaveBeenCalled();
      expect(replacePendingCheckIns).not.toHaveBeenCalled();
    });

    it('forwards a queued past-day timestamp as completed_on (#269, BUG-FE-HABIT-205)', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        { goal_id: 1, did_complete: true, timestamp: '2025-04-01T12:00:00Z' },
      ] as never);

      await habitManager.loadHabits('UTC');

      // The check-in queued on April 1 lands on April 1 — not on the
      // wall-clock day the device happened to reconnect.
      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: '2025-04-01',
      });
    });

    it('omits completed_on when the queued check-in is from today', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        { goal_id: 1, did_complete: true, timestamp: new Date().toISOString() },
      ] as never);

      await habitManager.loadHabits('UTC');

      // Same-day replays let the server stamp real wall-clock time —
      // mirrors the online path's genuine-backfill rule.
      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: undefined,
      });
    });

    it('tz-less internal re-fetches reuse the last known zone (#269)', async () => {
      (loadHabits as jest.Mock).mockResolvedValue([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValue([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
        // 22:00 UTC is already April 2 in Pacific/Kiritimati (UTC+14),
        // so the expected day proves the remembered zone is used — the
        // device-zone fallback (UTC under jest) would say April 1.
        { goal_id: 9, did_complete: true, timestamp: '2025-04-01T22:00:00Z' },
      ] as never);

      await habitManager.loadHabits('Pacific/Kiritimati');
      await habitManager.loadHabits();

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 9,
        did_complete: true,
        completed_on: '2025-04-02',
      });
    });

    it('keeps only the unprocessed suffix when replay fails mid-batch (BUG-FE-HABIT-205)', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
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

    it('keeps cached habits and does not set an error when a real cache exists and the API fails', async () => {
      const cached: Habit[] = [makeHabit({ id: 5, name: 'From Cache' })];
      (loadHabits as jest.Mock).mockResolvedValueOnce(cached as never);
      (habitsApi.listAll as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();

      const { habits, error } = useHabitStore.getState();
      expect(habits).toHaveLength(1);
      expect(habits[0]!.name).toBe('From Cache');
      expect(error).toBeNull();
    });

    it('does not replay cached goal targets when the post-recovery refetch fails', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, target: 30, target_unit: 'minutes' } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock)
        .mockResolvedValueOnce([] as never)
        .mockRejectedValueOnce(new Error('still down') as never);

      await habitManager.loadHabits();

      expect(habitsApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pranayama' }));
      expect(goalsApi.update).not.toHaveBeenCalled();
      const stored = useHabitStore.getState().habits;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.name).toBe('Pranayama');
    });

    it('replays a goal whose only difference from the server default is frequency', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, frequency: 2 } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(goalsApi.update).toHaveBeenCalledWith(992, expect.objectContaining({ frequency: 2 }));
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.frequency).toBe(2);
    });

    it('replays a goal whose only difference from the server default is is_additive', async () => {
      const cachedHabit = makeHabit({ id: 1, name: 'Pranayama' });
      cachedHabit.goals = cachedHabit.goals.map((g) =>
        g.tier === 'clear' ? { ...g, is_additive: false } : g,
      );
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedHabit] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never).mockResolvedValueOnce([
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
          goals: [
            freshServerGoal(991, 'Low', 'low', 1),
            freshServerGoal(992, 'Clear', 'clear', 2),
            freshServerGoal(993, 'Stretch', 'stretch', 3),
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(goalsApi.update).toHaveBeenCalledWith(
        992,
        expect.objectContaining({ is_additive: false }),
      );
      const clear = useHabitStore.getState().habits[0]!.goals.find((g) => g.tier === 'clear')!;
      expect(clear.is_additive).toBe(false);
    });

    it('skips a habit with an unparseable start_date when computing the program anchor', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 1,
          name: 'Broken Date',
          icon: '\u{1F9D8}',
          start_date: 'not-a-real-date',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
        {
          id: 2,
          name: 'Valid Date',
          icon: '\u{1F49C}',
          start_date: '2026-02-15',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Purple',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      const anchor = useProgramStore.getState().programStartDate;
      expect(anchor).not.toBeNull();
      expect(anchor!.getFullYear()).toBe(2026);
      expect(anchor!.getMonth()).toBe(1);
      expect(anchor!.getDate()).toBe(15);
    });

    it('narrows an unknown goal tier to the safe "clear" default instead of leaking the raw string', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 6,
          name: 'Tier Test',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          revealed: true,
          goals: [
            {
              id: 1,
              title: 'Odd',
              tier: 'bogus',
              target: 1,
              target_unit: 'units',
              frequency: 1,
              frequency_unit: 'per_day',
              is_additive: true,
            },
          ],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits[0]!.goals[0]!.tier).toBe('clear');
    });

    it('drops an unknown notification_frequency instead of casting it through', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 7,
          name: 'Notif Test',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          revealed: true,
          notification_frequency: 'sometimes' as never,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits[0]!.notificationFrequency).toBeUndefined();
    });

    it('carries a numeric sort_order from the API onto the stored habit', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 8,
          name: 'Ordered',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          revealed: true,
          sort_order: 3,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits[0]!.sort_order).toBe(3);
    });

    it('defaults sort_order to null when the API omits it', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 9,
          name: 'Unordered',
          icon: '\u{1F9D8}',
          start_date: '2025-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          revealed: true,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(useHabitStore.getState().habits[0]!.sort_order).toBeNull();
    });
  });

  describe('updateGoalUnits', () => {
    it('applies unit changes to every tier optimistically and PUTs once (#289)', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      habitManager.updateGoalUnits(1, { target_unit: 'hours' });

      const goals = useHabitStore.getState().habits[0]!.goals;
      expect(goals.every((g) => g.target_unit === 'hours')).toBe(true);
      // ONE consolidated batch call — the atomic replacement for the
      // three-PUT fan-out whose partial failure split tiers server-side.
      expect(habitsApi.updateGoalUnits).toHaveBeenCalledTimes(1);
      expect(habitsApi.updateGoalUnits).toHaveBeenCalledWith(1, {
        target_unit: 'hours',
        frequency: 1,
        frequency_unit: 'per_day',
      });
      expect(saveHabits).toHaveBeenCalled();
    });

    it('rolls every tier back when the batch PUT rejects (#289)', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      (
        (habitsApi as unknown as { updateGoalUnits: jest.Mock }).updateGoalUnits as jest.Mock
      ).mockRejectedValueOnce(new Error('boom') as never);

      habitManager.updateGoalUnits(1, { target_unit: 'hours' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const goals = useHabitStore.getState().habits[0]!.goals;
      // The single rollback restores the ORIGINAL units on every tier —
      // no mismatched split between local and server state.
      expect(goals.every((g) => g.target_unit === 'units')).toBe(true);
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).toHaveBeenCalled();
    });

    it('does nothing when no habit matches the given id', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });

      habitManager.updateGoalUnits(999, { target_unit: 'hours' });

      const goals = useHabitStore.getState().habits[0]!.goals;
      expect(goals.every((g) => g.target_unit === 'units')).toBe(true);
      expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
      expect(saveHabits).not.toHaveBeenCalled();
    });

    it('skips the network call when a tier goal has no synthetic id', () => {
      const habit = makeHabit();
      habit.goals = habit.goals.map((g, i) => (i === 0 ? { ...g, id: undefined } : g));
      useHabitStore.setState({ habits: [habit] });

      habitManager.updateGoalUnits(1, { target_unit: 'hours' });

      const goals = useHabitStore.getState().habits[0]!.goals;
      expect(goals.every((g) => g.target_unit === 'hours')).toBe(true);
      expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
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

    it('propagates is_additive to sibling tiers so a direction flip lands atomically', () => {
      // Updating ``low`` alone with ``is_additive=false`` must also flip
      // clear + stretch locally — otherwise ``normalizeGoalTiers`` would key
      // off ``low.is_additive`` and run the wrong clamp on subsequent fan-out
      // PUTs, leaving the store in a half-additive / half-subtractive state.
      useHabitStore.setState({ habits: [makeHabit()] });

      const flippedLow: Goal = {
        id: 1,
        title: 'Low',
        tier: 'low',
        target: 1,
        target_unit: 'units',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      };

      habitManager.updateGoal(1, flippedLow);

      const { goals } = useHabitStore.getState().habits[0]!;
      for (const tier of ['low', 'clear', 'stretch'] as const) {
        const goal = goals.find((g) => g.tier === tier)!;
        expect(goal.is_additive).toBe(false);
      }
    });

    it('does not mutate the goal objects of its input array', () => {
      // The optimistic snapshot in ``updateGoal`` shares goal object refs with
      // the ``prev`` rollback array; an in-place normalize would silently
      // corrupt the tiers the user never edited before the PUT even resolves.
      const habit = makeHabit();
      const low = habit.goals.find((g) => g.tier === 'low')!;
      const stretch = habit.goals.find((g) => g.tier === 'stretch')!;

      const editedClear: Goal = {
        ...habit.goals.find((g) => g.tier === 'clear')!,
        target: 10,
        target_unit: 'minutes',
      };

      applyGoalUpdate([habit], 1, editedClear);

      expect(low.target_unit).toBe('units');
      expect(low.target).toBe(1);
      expect(stretch.target_unit).toBe('units');
      expect(stretch.target).toBe(3);
    });

    it('rolls every tier back to its pre-edit state when the PUT rejects', async () => {
      const original = makeHabit();
      useHabitStore.setState({ habits: [original] });
      (goalsApi.update as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);

      const editedClear: Goal = {
        ...original.goals.find((g) => g.tier === 'clear')!,
        target: 10,
        target_unit: 'minutes',
      };

      habitManager.updateGoal(1, editedClear);
      await Promise.resolve();
      await Promise.resolve();

      const { goals } = useHabitStore.getState().habits[0]!;
      const byTier = (tier: string): Goal => goals.find((g) => g.tier === tier)!;
      // Every tier — including the untouched low + stretch — restores to the
      // exact pre-edit snapshot, not the corrupted optimistic values.
      expect(byTier('low').target_unit).toBe('units');
      expect(byTier('low').target).toBe(1);
      expect(byTier('clear').target_unit).toBe('units');
      expect(byTier('clear').target).toBe(2);
      expect(byTier('stretch').target_unit).toBe('units');
      expect(byTier('stretch').target).toBe(3);
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

    it('includes the revealed flag in the PUT payload so the lock state round-trips', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, revealed: true })] });
      const updated = { ...makeHabit(), revealed: false };

      habitManager.updateHabit(updated);

      expect(habitsApi.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ revealed: false }),
      );
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

  describe('addHabit', () => {
    it('optimistically appends the habit before the API resolves', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, name: 'Existing' })] });
      let resolveCreate: (() => void) | undefined;
      (habitsApi.create as jest.Mock).mockImplementationOnce(
        () => new Promise<unknown>((r) => (resolveCreate = () => r({}))),
      );

      const inFlight = habitManager.addHabit({ name: 'Brand New', icon: '🆕' });

      // Optimistic insert: present in the store before the API resolves.
      const optimistic = useHabitStore.getState().habits;
      expect(optimistic).toHaveLength(2);
      expect(optimistic[1]!.name).toBe('Brand New');
      expect(optimistic[1]!.icon).toBe('🆕');
      expect(optimistic[1]!.sort_order).toBe(1);

      resolveCreate?.();
      await inFlight;
    });

    it('cycles new habits through STAGE_ORDER for their aptitude color', async () => {
      useHabitStore.setState({ habits: [] });
      await habitManager.addHabit({ name: 'First', icon: '1️⃣' });
      const { habits } = useHabitStore.getState();
      expect(habits[habits.length - 1]!.stage).toBe('Beige');
    });

    it('buildAddedHabit defaults the new habit to locked', () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, name: 'Existing' })] });
      let resolveCreate: (() => void) | undefined;
      (habitsApi.create as jest.Mock).mockImplementationOnce(
        () => new Promise<unknown>((r) => (resolveCreate = () => r({}))),
      );

      const inFlight = habitManager.addHabit({ name: 'Brand New', icon: '🆕' });

      const optimistic = useHabitStore.getState().habits;
      expect(optimistic[1]!.revealed).toBe(false);

      resolveCreate?.();
      return inFlight;
    });

    it('posts the new habit to the server and reloads to pick up server ids', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });
      const serverHabit = {
        ...makeHabit({ id: 99, name: 'Brand New' }),
        start_date: '2026-05-10',
        milestone_notifications: false,
      };
      (habitsApi.listAll as jest.Mock).mockImplementationOnce(() => Promise.resolve([serverHabit]));

      await habitManager.addHabit({
        name: 'Brand New',
        icon: '🆕',
        energy_cost: 4,
        energy_return: 8,
      });

      expect(habitsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Brand New',
          icon: '🆕',
          energy_cost: 4,
          energy_return: 8,
        }),
      );
      // loadHabits ran, so the temporary negative id was replaced by id: 99.
      expect(useHabitStore.getState().habits[0]!.id).toBe(99);
    });

    it('rolls the store back and surfaces an error toast on API failure', async () => {
      const previousHabits = [makeHabit({ id: 1, name: 'Existing' })];
      useHabitStore.setState({ habits: previousHabits });
      (habitsApi.create as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(new Error('offline')),
      );
      const { Alert } = require('react-native');

      await habitManager.addHabit({ name: 'Will Fail', icon: '🛑' });

      const { habits } = useHabitStore.getState();
      expect(habits).toHaveLength(1);
      expect(habits[0]!.name).toBe('Existing');
      expect(saveHabits).toHaveBeenLastCalledWith(previousHabits);
      expect(Alert.alert).toHaveBeenCalledWith(
        "Couldn't sync",
        expect.stringContaining("couldn't create that habit"),
      );
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

    it('rolls back exactly once when any single PUT fails (consolidated Promise.all rollback)', async () => {
      // Invariant: a partial-failure reorder must restore the pre-write
      // snapshot once and only once. Per-row ``.catch`` chains would
      // restore ``prev`` per failure and clobber sibling writes that
      // already landed in the store. Restoration covers both the store
      // AND the on-disk snapshot — a hot reload and a cold relaunch
      // must agree with the rolled-back state.
      const h1 = makeHabit({ id: 1, name: 'First' });
      const h2 = makeHabit({ id: 2, name: 'Second' });
      const original = [h1, h2];
      useHabitStore.setState({ habits: original });
      (habitsApi.update as jest.Mock)
        .mockImplementationOnce(() => Promise.resolve({}) as never)
        .mockImplementationOnce(() => Promise.reject(new Error('boom')) as never);

      habitManager.saveHabitOrder([h2, h1]);
      // Optimistic state lands first.
      expect(useHabitStore.getState().habits.map((h) => h.name)).toEqual(['Second', 'First']);

      // Let the rejected Promise.all settle.
      await new Promise((resolve) => setImmediate(resolve));

      // Single in-memory rollback to the snapshot taken before the
      // optimistic write.
      expect(useHabitStore.getState().habits.map((h) => h.name)).toEqual(['First', 'Second']);
      // AND the on-disk snapshot rolls back too, so a cold relaunch
      // sees the same order as the in-memory store.
      expect(saveHabits).toHaveBeenLastCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 1, name: 'First' }),
          expect.objectContaining({ id: 2, name: 'Second' }),
        ]),
      );
    });
  });

  describe('logUnit primitives (apply / commit / rollback)', () => {
    it('prepareLogUnit + applyLogUnitContext appends a completion and returns the updated habit', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC');
      expect(ctx).not.toBeNull();
      habitManager.applyLogUnitContext(ctx!);

      expect(ctx!.next[0]!.completions).toHaveLength(1);
      expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
    });

    it('commitLogUnitContext POSTs the goal completion to the API', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;
      habitManager.applyLogUnitContext(ctx);

      await habitManager.commitLogUnitContext(ctx);

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: ctx.currentGoal.id,
        did_complete: true,
      });
    });

    it('prepareLogUnit records completedOn when backfilling a past day', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC', yesterday)!;

      expect(ctx.completedOn).toBe(dayKeyInTZ(yesterday, 'UTC'));
    });

    it('prepareLogUnit leaves completedOn undefined when the date is today', () => {
      useHabitStore.setState({ habits: [makeHabit()] });

      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC', new Date())!;

      expect(ctx.completedOn).toBeUndefined();
    });

    it('commitLogUnitContext forwards completed_on for a backfilled day', async () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC', yesterday)!;

      await habitManager.commitLogUnitContext(ctx);

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: ctx.currentGoal.id,
        did_complete: true,
        completed_on: dayKeyInTZ(yesterday, 'UTC'),
      });
    });

    it('buildLogUnitToast returns a milestone config when a tier is reached', () => {
      useHabitStore.setState({ habits: [makeHabit()] });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

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
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast).not.toBeNull();
      expect(toast!.message).toMatch(/logged/i);
    });

    it('rollbackLogUnitContext restores both the store AND the persisted snapshot', () => {
      const habit = makeHabit();
      const prev = [habit];
      useHabitStore.setState({ habits: prev });

      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;
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

      const ctx = habitManager.prepareLogUnit(999, 1, 'UTC');

      expect(ctx).toBeNull();
    });

    // Regression: when the tz arg was hardcoded UTC, milestone toasts could
    // re-fire (or fire on the wrong baseline) when the user's local day
    // boundary disagreed with UTC's. Pinning the bucketing in two zones with
    // an inverted boundary proves the tz parameter actually reaches the
    // calc, not just the function signature.
    it('prepareLogUnit buckets oldProgress in the supplied IANA zone', () => {
      // Anchor "now" to 12:00 UTC so the relationship between the completion
      // (04:00 UTC same day) and the UTC/Anchorage "today" is deterministic
      // regardless of when CI runs. Without this anchor, runs in the early
      // UTC morning saw Anchorage's "today" match the completion's previous-day
      // bucket and flipped the assertion.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));
      try {
        const earlyUtc = new Date('2026-05-15T04:00:00.000Z');

        useHabitStore.setState({
          habits: [
            makeHabit({
              completions: [{ id: 'pre', timestamp: earlyUtc, completed_units: 1 }],
            }),
          ],
        });

        const utcCtx = habitManager.prepareLogUnit(1, 1, 'UTC')!;
        // In UTC, the prior completion is in today's bucket -> oldProgress = 1.
        expect(utcCtx.oldProgress).toBe(1);

        // Reset the store so the second prepareLogUnit sees the same baseline.
        useHabitStore.setState({
          habits: [
            makeHabit({
              completions: [{ id: 'pre', timestamp: earlyUtc, completed_units: 1 }],
            }),
          ],
        });

        const anchorageCtx = habitManager.prepareLogUnit(1, 1, 'America/Anchorage')!;
        // In Anchorage, the prior completion landed in yesterday's bucket ->
        // oldProgress = 0, so milestone detection treats this as a fresh start.
        expect(anchorageCtx.oldProgress).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('backfillMissedDays', () => {
    it('adds backfill completions and bumps the streak', () => {
      useHabitStore.setState({ habits: [makeHabit({ streak: 2 })] });

      habitManager.backfillMissedDays(1, [new Date('2025-01-02'), new Date('2025-01-03')]);

      const habit = useHabitStore.getState().habits[0]!;
      expect(habit.streak).toBe(4);
      expect(habit.completions).toHaveLength(2);
      // #783: must persist or the backfill is lost on the next cold rehydrate.
      expect(saveHabits).toHaveBeenLastCalledWith([expect.objectContaining({ streak: 4 })]);
    });

    // The bug this whole suite pins: a backfill that only ever touches the
    // Zustand store is silently erased the moment loadHabits() re-fetches,
    // because handleApiSuccess trusts the server as the source of truth.
    it('survives the next loadHabits reload once the completions are posted', async () => {
      const habit = makeHabit({ id: 1, streak: 0 });
      useHabitStore.setState({ habits: [habit] });
      // Fixed, unambiguously-past calendar days — no system-time anchor needed.
      const dayOne = new Date('2020-06-10T00:00:00.000Z');
      const dayTwo = new Date('2020-06-11T00:00:00.000Z');

      // Stand in for the server: what it returns is only what actually got
      // posted, so a fix that forgets the POST reloads back to nothing.
      (habitsApi.listAll as jest.Mock).mockImplementationOnce(() => {
        const posted = (goalCompletionsApi.create as jest.Mock).mock.calls.map(
          (call) => call[0] as { completed_on?: string },
        );
        return Promise.resolve([
          {
            id: 1,
            name: habit.name,
            icon: habit.icon,
            start_date: '2020-01-01',
            energy_cost: 1,
            energy_return: 2,
            stage: 'Beige',
            streak: posted.length,
            milestone_notifications: false,
            revealed: true,
            goals: [
              {
                ...freshServerGoal(1, 'Low', 'low', 1),
                completions: posted.map((p, i) => ({
                  id: i + 1,
                  timestamp: `${p.completed_on ?? '2020-06-12'}T00:00:00.000Z`,
                  completed_units: 1,
                })),
              },
              freshServerGoal(2, 'Clear', 'clear', 2),
              freshServerGoal(3, 'Stretch', 'stretch', 3),
            ],
          },
        ] as never);
      });

      habitManager.backfillMissedDays(1, [dayOne, dayTwo], 'UTC');
      // Flush the fire-and-forget POST fan-out before reloading.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      await habitManager.loadHabits('UTC');

      const reloaded = useHabitStore.getState().habits.find((h) => h.id === 1)!;
      const dayKeys = (reloaded.completions ?? []).map((c) => dayKeyInTZ(c.timestamp, 'UTC'));
      expect(dayKeys).toEqual(expect.arrayContaining(['2020-06-10', '2020-06-11']));
    });

    it('POSTs one completion per missed day against the low-tier goal', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, streak: 0 })] });
      const dayOne = new Date('2020-06-10T00:00:00.000Z');
      const dayTwo = new Date('2020-06-11T00:00:00.000Z');

      habitManager.backfillMissedDays(1, [dayOne, dayTwo], 'UTC');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(2);
      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: '2020-06-10',
      });
      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: '2020-06-11',
      });
    });

    it('buckets completed_on using the supplied IANA zone, not UTC', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, streak: 0 })] });
      const day = new Date('2020-06-10T03:00:00.000Z');
      const expectedAnchorageKey = dayKeyInTZ(day, 'America/Anchorage');
      // Sanity check the fixture actually straddles the UTC/Anchorage
      // boundary — otherwise the assertion below would pass by accident.
      expect(expectedAnchorageKey).not.toBe(dayKeyInTZ(day, 'UTC'));

      habitManager.backfillMissedDays(1, [day], 'America/Anchorage');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: expectedAnchorageKey,
      });
    });

    it('rolls back the store and disk, and alerts the user, when a completion POST rejects', async () => {
      const habit = makeHabit({ id: 1, streak: 2, completions: [] });
      const prev = [habit];
      useHabitStore.setState({ habits: prev });
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      habitManager.backfillMissedDays(1, [new Date('2025-01-02'), new Date('2025-01-03')], 'UTC');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      const rolledBack = useHabitStore.getState().habits[0]!;
      expect(rolledBack.streak).toBe(2);
      expect(rolledBack.completions).toHaveLength(0);
      expect(saveHabits).toHaveBeenLastCalledWith(prev);
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).toHaveBeenCalled();
    });

    it('skips the network call but still applies the optimistic update when the low goal has no id', async () => {
      const habit = makeHabit({ streak: 1 });
      habit.goals = habit.goals.map((g) => (g.tier === 'low' ? { ...g, id: undefined } : g));
      useHabitStore.setState({ habits: [habit] });

      habitManager.backfillMissedDays(1, [new Date('2025-01-02')], 'UTC');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      const updated = useHabitStore.getState().habits[0]!;
      expect(updated.streak).toBe(2);
      expect(updated.completions).toHaveLength(1);
      expect(saveHabits).toHaveBeenLastCalledWith([expect.objectContaining({ streak: 2 })]);
      expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    });
  });

  describe('setNewStartDate', () => {
    it('resets streak and completions when the start date changes, and PUTs it', async () => {
      const habit = makeHabit({
        streak: 10,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      useHabitStore.setState({ habits: [habit] });

      const newDate = new Date('2025-06-01');
      habitManager.setNewStartDate(1, newDate);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      const updated = useHabitStore.getState().habits[0]!;
      expect(updated.streak).toBe(0);
      expect(updated.completions).toEqual([]);
      expect(updated.start_date).toEqual(newDate);
      // #783: must persist or the reset start date is lost on the next rehydrate.
      expect(saveHabits).toHaveBeenLastCalledWith([
        expect.objectContaining({ start_date: newDate }),
      ]);
      // Must reach the server too — otherwise the next loadHabits() GET
      // returns the stale start_date and silently reverts the reset.
      expect(habitsApi.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ start_date: '2025-06-01' }),
      );
    });

    it('rolls back the store and disk, and alerts the user, when the start-date PUT rejects', async () => {
      const habit = makeHabit({
        streak: 10,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      const prev = [habit];
      useHabitStore.setState({ habits: prev });
      (habitsApi.update as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      habitManager.setNewStartDate(1, new Date('2025-06-01'));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      const rolledBack = useHabitStore.getState().habits[0]!;
      expect(rolledBack.streak).toBe(10);
      expect(rolledBack.completions).toHaveLength(1);
      expect(saveHabits).toHaveBeenLastCalledWith(prev);
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).toHaveBeenCalled();
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

    it('buildOnboardingHabits defaults every habit to locked, regardless of stage', async () => {
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
        {
          id: 'b',
          name: 'Journal',
          icon: '\u{1F4D3}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Purple',
          start_date: new Date('2025-01-22'),
        },
      ];

      await habitManager.onboardingSave(newHabits, jest.fn());

      const habits = useHabitStore.getState().habits;
      expect(habits.every((h) => h.revealed === false)).toBe(true);
    });

    it('anchors the universal program calendar to the earliest habit start date', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);
      const newHabits: OnboardingHabit[] = [
        {
          id: 'b',
          name: 'Belong',
          icon: '\u{1F49C}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Purple',
          start_date: new Date('2026-01-22'),
        },
        {
          id: 'a',
          name: 'Survive',
          icon: '\u{1F9D8}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Beige',
          start_date: new Date('2026-01-01'),
        },
      ];

      await habitManager.onboardingSave(newHabits, jest.fn());

      const anchor = useProgramStore.getState().programStartDate;
      // Normalised to local midnight by the store; compare the calendar day.
      expect(anchor).not.toBeNull();
      expect(anchor!.getFullYear()).toBe(2026);
      expect(anchor!.getMonth()).toBe(0);
      expect(anchor!.getDate()).toBe(1);
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
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
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
    it('revealAllHabits flips every habit to revealed=true and PUTs each to the API', async () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, revealed: false }), makeHabit({ id: 2, revealed: false })],
      });

      habitManager.revealAllHabits();
      await Promise.resolve();

      expect(useHabitStore.getState().habits.every((h) => h.revealed === true)).toBe(true);
      expect(habitsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ revealed: true }));
      expect(habitsApi.update).toHaveBeenCalledWith(2, expect.objectContaining({ revealed: true }));
    });

    it('revealAllHabits rolls every habit back to its pre-unlock state when a PUT rejects', async () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, revealed: false }), makeHabit({ id: 2, revealed: false })],
      });
      (habitsApi.update as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);

      habitManager.revealAllHabits();
      await new Promise((resolve) => setImmediate(resolve));

      const habits = useHabitStore.getState().habits;
      expect(habits.every((h) => h.revealed === false)).toBe(true);
    });

    it('lockUntouchedHabits re-locks only habits with zero logged completions', () => {
      useHabitStore.setState({
        habits: [
          makeHabit({ id: 1, revealed: true, completions: [] }),
          makeHabit({
            id: 2,
            revealed: true,
            completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
          }),
        ],
      });

      habitManager.lockUntouchedHabits();

      const habits = useHabitStore.getState().habits;
      expect(habits[0]!.revealed).toBe(false);
      expect(habits[1]!.revealed).toBe(true);
    });

    it('lockUntouchedHabits leaves a zero-completion habit locked even with a past start_date', () => {
      // The old ``lockUnstartedHabits`` kept a past-start_date habit revealed;
      // the new re-lock affordance keys ONLY off completions, so a
      // never-touched habit re-locks regardless of its calendar date.
      useHabitStore.setState({
        habits: [
          makeHabit({
            id: 1,
            revealed: true,
            start_date: new Date(Date.now() - 1000 * 60 * 60 * 24),
            completions: [],
          }),
        ],
      });

      habitManager.lockUntouchedHabits();

      expect(useHabitStore.getState().habits[0]!.revealed).toBe(false);
    });

    it('unlockHabit reveals a single habit by id and PUTs it to the API', () => {
      useHabitStore.setState({
        habits: [makeHabit({ id: 1, revealed: false }), makeHabit({ id: 2, revealed: false })],
      });

      habitManager.unlockHabit(1);

      const habits = useHabitStore.getState().habits;
      expect(habits[0]!.revealed).toBe(true);
      expect(habits[1]!.revealed).toBe(false);
      expect(habitsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ revealed: true }));
    });

    it('unlockHabit rolls the store back when the API rejects', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, revealed: false })] });
      (habitsApi.update as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);

      habitManager.unlockHabit(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(useHabitStore.getState().habits[0]!.revealed).toBe(false);
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

    it('rolls the icon back IN MEMORY AND ON DISK when the API rejects the PUT', async () => {
      // Invariant: an emoji edit is optimistic. The optimistic write
      // lands in BOTH the in-memory store and AsyncStorage (so a hot
      // reload reflects it). When the server rejects, the rollback
      // must restore BOTH surfaces — without the on-disk rollback, a
      // cold relaunch rehydrates the failed write and silently
      // diverges from the server. That's the same cold-rehydrate
      // failure mode this PR's emoji/order fixes set out to close.
      useHabitStore.setState({ habits: [makeHabit({ id: 1, icon: 'A' })] });
      (habitsApi.update as jest.Mock).mockImplementationOnce(
        () => Promise.reject(new Error('boom')) as never,
      );

      habitManager.setEmojiForHabit(0, '\u{2728}');
      // Optimistic write hits both the store and the disk snapshot.
      expect(useHabitStore.getState().habits[0]!.icon).toBe('\u{2728}');
      expect(saveHabits).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 1, icon: '\u{2728}' })]),
      );

      // Let the rejected catch handler run.
      await new Promise((resolve) => setImmediate(resolve));

      // In-memory rollback.
      expect(useHabitStore.getState().habits[0]!.icon).toBe('A');
      expect(habitsApi.update).toHaveBeenCalledTimes(1);
      // AND the on-disk snapshot rolls back to the original icon, so
      // a cold relaunch sees the same state the user does.
      expect(saveHabits).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 1, icon: 'A' })]),
      );
    });
  });

  describe('onboardingSave error handling', () => {
    it('logs and continues when a single habit fails to sync during onboarding', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      (habitsApi.create as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);
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

      await habitManager.onboardingSave(newHabits, jest.fn());

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Meditate'));
      expect(useHabitStore.getState().habits).toHaveLength(1);
      errorSpy.mockRestore();
    });
  });

  describe('updateGoalUnits edge cases', () => {
    it('does nothing when the matched habit has no goals to read a reference from', () => {
      const emptyHabit = { ...makeHabit({ id: 5 }), goals: [] };
      useHabitStore.setState({ habits: [emptyHabit] });

      habitManager.updateGoalUnits(5, { target_unit: 'hours' });

      expect(useHabitStore.getState().habits[0]!.goals).toEqual([]);
      expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
      expect(saveHabits).not.toHaveBeenCalled();
    });
  });

  describe('saveHabitOrder with no server ids', () => {
    it('stamps sort_order and persists locally without calling the API when no habit has an id', () => {
      const local1 = { ...makeHabit({ id: 1 }), id: undefined } as unknown as Habit;
      const local2 = { ...makeHabit({ id: 2 }), id: undefined } as unknown as Habit;
      useHabitStore.setState({ habits: [local1, local2] });

      habitManager.saveHabitOrder([local2, local1]);

      const stored = useHabitStore.getState().habits;
      expect(stored.map((h) => h.sort_order)).toEqual([0, 1]);
      expect(saveHabits).toHaveBeenCalled();
      expect(habitsApi.update).not.toHaveBeenCalled();
    });
  });

  describe('commitLogUnitContext with a synthetic (id-less) current goal', () => {
    it('returns null and skips the API call when the current goal has no server id', async () => {
      const habit = makeHabit();
      habit.goals = habit.goals.map((g) => (g.tier === 'low' ? { ...g, id: undefined } : g));
      useHabitStore.setState({ habits: [habit] });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      const result = await habitManager.commitLogUnitContext(ctx);

      expect(result).toBeNull();
      expect(goalCompletionsApi.create).not.toHaveBeenCalled();
    });
  });

  describe('buildLogUnitToast tier-specific milestone copy', () => {
    it('returns the Clear Goal milestone toast when the log crosses the clear threshold', () => {
      useHabitStore.setState({
        habits: [
          makeHabit({
            completions: [{ id: 'pre', timestamp: new Date(), completed_units: 1 }],
          }),
        ],
      });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast.message).toMatch(/Clear Goal achieved/i);
    });

    it('returns the Stretch Goal milestone toast when the log crosses the stretch threshold', () => {
      useHabitStore.setState({
        habits: [
          makeHabit({
            completions: [{ id: 'pre', timestamp: new Date(), completed_units: 2 }],
          }),
        ],
      });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast.message).toMatch(/Stretch Goal achieved/i);
    });

    it('falls back to the confirmation toast for a subtractive goal even when a threshold is crossed', () => {
      const subtractiveHabit = makeHabit();
      subtractiveHabit.goals = subtractiveHabit.goals.map((g) => ({ ...g, is_additive: false }));
      useHabitStore.setState({ habits: [subtractiveHabit] });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      const toast = habitManager.buildLogUnitToast(ctx);

      expect(toast.message).toMatch(/logged/i);
    });
  });

  describe('toApiPayload defensive start_date handling', () => {
    it('stringifies a non-Date start_date instead of crashing (defensive cast)', () => {
      const habit = { ...makeHabit(), start_date: '2025-06-01' } as unknown as Habit;
      useHabitStore.setState({ habits: [habit] });

      habitManager.updateHabit(habit);

      expect(habitsApi.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ start_date: '2025-06-01' }),
      );
    });
  });

  describe('replayPendingCheckIns with an explicit completed_on already queued', () => {
    it('forwards the explicit completed_on instead of re-deriving it from the timestamp', async () => {
      (loadHabits as jest.Mock).mockResolvedValueOnce([] as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce([
        {
          goal_id: 1,
          did_complete: true,
          timestamp: '2025-04-05T00:00:00Z',
          completed_on: '2025-03-01',
        },
      ] as never);

      await habitManager.loadHabits('UTC');

      expect(goalCompletionsApi.create).toHaveBeenCalledWith({
        goal_id: 1,
        did_complete: true,
        completed_on: '2025-03-01',
      });
    });
  });

  describe('syncProgramAnchorFromHabits idempotency', () => {
    it('does not re-set the program anchor when it already matches the earliest habit start date', async () => {
      const anchor = new Date('2026-01-01T00:00:00Z');
      useProgramStore.getState().hydrateProgramStartDate(anchor);
      const setStateSpy = jest.spyOn(useProgramStore, 'setState');
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 1,
          name: 'Survive',
          icon: '\u{1F9D8}',
          start_date: '2026-01-01',
          energy_cost: 1,
          energy_return: 2,
          stage: 'Beige',
          streak: 0,
          milestone_notifications: false,
          goals: [],
        },
      ] as never);

      await habitManager.loadHabits();

      expect(setStateSpy).not.toHaveBeenCalled();
      setStateSpy.mockRestore();
    });
  });
});
