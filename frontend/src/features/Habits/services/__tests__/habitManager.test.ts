import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
    clearCompletions: jest.fn(() => Promise.resolve({})),
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

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));

import type * as ApiModule from '../../../../api';
import {
  ApiError,
  ApiValidationError,
  habits as habitsApi,
  goalCompletions as goalCompletionsApi,
  goalGroups as goalGroupsApi,
  goals as goalsApi,
} from '../../../../api';
import {
  saveHabits,
  loadHabits,
  clearDroppedCheckIns,
  loadDroppedCheckIns,
  loadPendingCheckIns,
  clearPendingCheckIns,
  recordDroppedCheckIn,
  replacePendingCheckIns,
} from '../../../../storage/habitStorage';
import type { DroppedCheckInState } from '../../../../store/useDroppedCheckInStore';
import { useHabitStore } from '../../../../store/useHabitStore';
import { programStage, programWeek, useProgramStore } from '../../../../store/useProgramStore';
import { dayKeyInTZ } from '../../../../utils/dateUtils';
import { HABIT_DEFAULTS } from '../../HabitDefaults';
import type { Goal, Habit, HabitMergePlan, OnboardingHabit } from '../../Habits.types';
import { buildPagedHabits, carryoverSlot, countCarryover, stageAtIndex } from '../../HabitUtils';
import { cancelForHabit } from '../../hooks/useHabitNotifications';
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

// A frozen stand-in for the ``-Date.now()`` placeholder ``buildAddedHabit``
// mints, so the synthetic-id cases never drift with the clock.
const SYNTHETIC_HABIT_ID = -1_756_000_000_000;

// Ids well outside the demo seed's 1..10 habit / 1..30 goal ranges, so an
// assertion on them cannot pass by coincidence.
const SERVER_HABIT_ID = 42;
const SERVER_GOAL_IDS = [91, 92, 93];

/** A demo placeholder tile: a positive, truthy, entirely fabricated id. */
const makeDemoHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({ isDemoSeed: true, ...overrides });

/** A pre-sync added habit: negative habit id, negative goal ids, minted on this device. */
const makeSyntheticHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({
    id: SYNTHETIC_HABIT_ID,
    hasClientMintedIds: true,
    goals: makeHabit().goals.map((g, i) => ({ ...g, id: SYNTHETIC_HABIT_ID - i - 1 })),
    ...overrides,
  });

// Deliberately inside the 1..10 habit / 1..30 goal range the server also uses,
// so no assertion can pass by the id merely looking fabricated.
const SCAFFOLD_HABIT_ID = 3;
const SCAFFOLD_GOAL_IDS = [7, 8, 9];

/** An onboarding scaffold row: positive ids in the server's own range, minted on this device. */
const makeScaffoldHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({
    id: SCAFFOLD_HABIT_ID,
    name: 'Scaffold',
    hasClientMintedIds: true,
    goals: makeHabit().goals.map((g, i) => ({ ...g, id: SCAFFOLD_GOAL_IDS[i]! })),
    ...overrides,
  });

/** A row the server really issued ids for. */
const makeServerHabit = (overrides: Partial<Habit> = {}): Habit =>
  makeHabit({
    id: SERVER_HABIT_ID,
    name: 'Real',
    goals: makeHabit().goals.map((g, i) => ({ ...g, id: SERVER_GOAL_IDS[i]! })),
    ...overrides,
  });

/** Goal ids in the order they were POSTed, so a test can pin both count and value. */
const postedGoalIds = (): number[] =>
  (goalCompletionsApi.create as jest.Mock).mock.calls.map(
    (call) => (call[0] as { goal_id: number }).goal_id,
  );

/**
 * The habit list of the most recent cache write. "Nothing was written" and "an
 * empty list was written" are the same invariant, so an uncalled saveHabits
 * reads as an empty payload.
 */
const lastPersisted = (): Habit[] => {
  const call = (saveHabits as jest.Mock).mock.calls.at(-1);
  if (!call) return [];
  return call[0] as Habit[];
};

interface DroppedStore {
  getState: () => DroppedCheckInState;
}

// Required lazily so a missing store module fails only the tests that read it.
const droppedStore = (): DroppedStore =>
  (
    require('../../../../store/useDroppedCheckInStore') as {
      useDroppedCheckInStore: DroppedStore;
    }
  ).useDroppedCheckInStore;

// Fixed so the program-clock assertions never drift with the calendar.
const FIXED_TODAY = new Date(2026, 5, 1);

// The demo seed as it looks once AsyncStorage hands it back on a later launch.
const CACHED_DEMO_TILES: Habit[] = HABIT_DEFAULTS.map((habit): Habit => ({
  ...habit,
  revealed: true,
  completions: [],
  isDemoSeed: true,
}));

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

    it('does NOT anchor the program calendar to the demo seed on a repeat load in the same session', async () => {
      // Second load of the same session: the demo tiles are already in the
      // store, so nothing re-seeds and the per-call guard opens. The anchor
      // must still ignore their hard-coded 2025 dates.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();
      await habitManager.loadHabits();

      const anchor = useProgramStore.getState().programStartDate;
      expect(useHabitStore.getState().habits.length).toBeGreaterThan(0);
      expect(anchor).toBeNull();
      expect(programStage(anchor, FIXED_TODAY)).toBeNull();
      expect(programWeek(anchor, FIXED_TODAY)).toBeNull();
    });

    it('does NOT anchor the program calendar to the demo seed on a repeat load after an API failure', async () => {
      // Same repeat-load hazard down the ``handleApiError`` seeding path.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock)
        .mockRejectedValueOnce(new Error('boom') as never)
        .mockRejectedValueOnce(new Error('boom') as never);

      await habitManager.loadHabits();
      await habitManager.loadHabits();

      const anchor = useProgramStore.getState().programStartDate;
      expect(useHabitStore.getState().habits.length).toBeGreaterThan(0);
      expect(anchor).toBeNull();
      expect(programStage(anchor, FIXED_TODAY)).toBeNull();
      expect(programWeek(anchor, FIXED_TODAY)).toBeNull();
    });

    it('does NOT anchor the program calendar to demo tiles restored from the cache', async () => {
      // A later launch reads the demo seed back out of AsyncStorage, so the
      // tiles arrive as cached data rather than a fresh seed. They carry the
      // demo marker and stay excluded from the anchor. A demo-only cache is
      // not a stuck user, so recovery never runs and there is no second fetch.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock).mockResolvedValueOnce(CACHED_DEMO_TILES as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      const anchor = useProgramStore.getState().programStartDate;
      expect(anchor).toBeNull();
      expect(programStage(anchor, FIXED_TODAY)).toBeNull();
      expect(programWeek(anchor, FIXED_TODAY)).toBeNull();
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

    it('computes the program slot from the non-carryover count, not the raw store length', async () => {
      const prev = [
        makeHabit({ id: 1, name: 'Program One' }),
        makeHabit({ id: 2, name: 'Program Two' }),
        makeHabit({ id: 3, name: 'Program Three' }),
        makeHabit({ id: 4, name: 'Carry One', is_carryover: true }),
        makeHabit({ id: 5, name: 'Carry Two', is_carryover: true }),
      ];
      useHabitStore.setState({ habits: prev });
      let resolveCreate: (() => void) | undefined;
      (habitsApi.create as jest.Mock).mockImplementationOnce(
        () => new Promise<unknown>((r) => (resolveCreate = () => r({}))),
      );

      const inFlight = habitManager.addHabit({ name: 'Fourth Program', icon: '\u{1F331}' });

      const optimistic = useHabitStore.getState().habits;
      const added = optimistic[optimistic.length - 1]!;
      expect(added.sort_order).toBe(3);
      expect(added.sort_order).not.toBe(5);
      expect(added.stage).toBe(stageAtIndex(3));
      expect(added.stage).not.toBe(stageAtIndex(5));
      expect(added.is_carryover ?? false).toBe(false);

      resolveCreate?.();
      await inFlight;
    });

    it('a carryover add flags the habit and takes the next negative slot', async () => {
      const prev = [
        makeHabit({ id: 1, name: 'Program One' }),
        makeHabit({ id: 2, name: 'Program Two' }),
        makeHabit({ id: 3, name: 'Program Three' }),
        makeHabit({ id: 4, name: 'Carry One', is_carryover: true }),
        makeHabit({ id: 5, name: 'Carry Two', is_carryover: true }),
      ];
      useHabitStore.setState({ habits: prev });
      let resolveCreate: (() => void) | undefined;
      (habitsApi.create as jest.Mock).mockImplementationOnce(
        () => new Promise<unknown>((r) => (resolveCreate = () => r({}))),
      );

      const inFlight = habitManager.addHabit({ name: 'Morning Walk', icon: '\u{1F6B6}' }, true);

      const optimistic = useHabitStore.getState().habits;
      const added = optimistic[optimistic.length - 1]!;
      expect(added.is_carryover).toBe(true);
      expect(added.sort_order).toBe(countCarryover(prev));
      expect(added.sort_order).toBe(2);
      expect(added.stage).toBe(stageAtIndex(carryoverSlot(2)));

      resolveCreate?.();
      await inFlight;
    });

    it('posts a carryover payload with is_carryover true and an unshifted today start_date', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });

      await habitManager.addHabit({ name: 'Evening Read', icon: '\u{1F4DA}' }, true);

      const today = new Date().toISOString().slice(0, 10);
      expect(habitsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_carryover: true, start_date: today }),
      );
    });

    it('sends is_carryover false for a program add and preserves the flag on habit PUTs', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1 })] });

      await habitManager.addHabit({ name: 'Plain Add', icon: '\u{2728}' });

      expect(habitsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ is_carryover: false }),
      );

      habitManager.updateHabit(makeHabit({ id: 1, is_carryover: true }));

      expect(habitsApi.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ is_carryover: true }),
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

    it('stamps and persists a demo-only reorder without PUTting the fabricated ids', () => {
      const d1 = makeHabit({ id: 1, name: 'First', isDemoSeed: true });
      const d2 = makeHabit({ id: 2, name: 'Second', isDemoSeed: true });
      useHabitStore.setState({ habits: [d1, d2] });

      habitManager.saveHabitOrder([d2, d1]);

      const stored = useHabitStore.getState().habits;
      expect(stored.map((h) => h.name)).toEqual(['Second', 'First']);
      expect(stored.map((h) => h.sort_order)).toEqual([0, 1]);
      expect(habitsApi.update).not.toHaveBeenCalled();
    });

    it('PUTs only the server-backed row while demo tiles still occupy their sort positions', () => {
      // id 42 sits outside the demo seed's 1..10 range, so the assertion cannot pass by coincidence.
      const d1 = makeHabit({ id: 1, name: 'First', isDemoSeed: true });
      const d2 = makeHabit({ id: 2, name: 'Second', isDemoSeed: true });
      const real = makeHabit({ id: 42, name: 'Real' });
      useHabitStore.setState({ habits: [d1, d2, real] });

      habitManager.saveHabitOrder([d2, real, d1]);

      expect(habitsApi.update).toHaveBeenCalledTimes(1);
      expect(habitsApi.update).toHaveBeenCalledWith(42, expect.objectContaining({ sort_order: 1 }));
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
      // The PUT alone does not delete completion rows server-side; clearing
      // them is a separate call so the reset survives the next refetch.
      expect(habitsApi.clearCompletions).toHaveBeenCalledWith(1);
    });

    it('reflects a cleared server state on the next loadHabits refetch, with no resurrected rows', async () => {
      const habit = makeHabit({
        id: 1,
        streak: 10,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      useHabitStore.setState({ habits: [habit] });
      // Stand in for the server: the refetch only comes back cleared if the
      // clear-completions call actually reached it, so a fix that forgets
      // the DELETE reloads pre-reset rows straight back.
      (habitsApi.listAll as jest.Mock).mockImplementationOnce(() => {
        const cleared = (habitsApi.clearCompletions as jest.Mock).mock.calls.length > 0;
        return Promise.resolve([
          {
            id: 1,
            name: habit.name,
            icon: habit.icon,
            start_date: '2025-06-01',
            energy_cost: 1,
            energy_return: 2,
            stage: 'Beige',
            streak: cleared ? 0 : 10,
            milestone_notifications: false,
            revealed: true,
            goals: [
              {
                ...freshServerGoal(1, 'Low', 'low', 1),
                completions: cleared
                  ? []
                  : [{ id: 1, timestamp: '2025-05-01T00:00:00.000Z', completed_units: 1 }],
              },
              { ...freshServerGoal(2, 'Clear', 'clear', 2), completions: [] },
              { ...freshServerGoal(3, 'Stretch', 'stretch', 3), completions: [] },
            ],
          },
        ] as never);
      });

      habitManager.setNewStartDate(1, new Date('2025-06-01'));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      await habitManager.loadHabits('UTC');

      const reloaded = useHabitStore.getState().habits.find((h) => h.id === 1)!;
      expect(reloaded.streak).toBe(0);
      expect(reloaded.completions).toEqual([]);
    });

    it('keeps the durably-saved start date and only warns when clearCompletions rejects', async () => {
      const habit = makeHabit({
        id: 1,
        streak: 10,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      const prev = [habit];
      useHabitStore.setState({ habits: prev });
      (habitsApi.clearCompletions as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);

      habitManager.setNewStartDate(1, new Date('2025-06-01'));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      // The PUT resolved, so the new start date is already durable server-side.
      // A failed clear must not roll the store back to the stale start date;
      // the optimistic reset holds and the user is told the clear failed.
      const after = useHabitStore.getState().habits[0]!;
      expect(after.streak).toBe(0);
      expect(after.completions).toEqual([]);
      expect(saveHabits).not.toHaveBeenLastCalledWith(prev);
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).toHaveBeenCalledWith(
        "Couldn't sync",
        expect.stringContaining('old check-ins'),
      );
    });

    it('skips both network calls for an id-less habit but still applies the optimistic reset', async () => {
      const habit = makeHabit({
        id: 0,
        streak: 5,
        completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
      });
      useHabitStore.setState({ habits: [habit] });

      habitManager.setNewStartDate(0, new Date('2025-06-01'));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      const updated = useHabitStore.getState().habits[0]!;
      expect(updated.streak).toBe(0);
      expect(updated.completions).toEqual([]);
      expect(habitsApi.update).not.toHaveBeenCalled();
      expect(habitsApi.clearCompletions).not.toHaveBeenCalled();
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

  describe('onboardingSave merge', () => {
    const MEDITATE = 'Meditate';
    const EVENING_READ = 'Evening Read';
    const KEPT_HABIT_ID = 47;
    const KEPT_GOAL_IDS = [101, 102, 103];
    const CARRYOVER_ID = 51;
    const CARRYOVER_START = new Date('2020-03-04');
    const PICK_START = new Date('2026-01-01');

    /** A pick as the onboarding modal emits it: a chip key, never a habit id. */
    const pick = (overrides: Partial<OnboardingHabit> = {}): OnboardingHabit => ({
      id: 'a',
      name: MEDITATE,
      icon: '\u{1F9D8}',
      energy_cost: 1,
      energy_return: 3,
      stage: 'Purple',
      start_date: PICK_START,
      ...overrides,
    });

    /** A habit the server issued ids for, with history the merge must not wipe. */
    const keptHabit = (overrides: Partial<Habit> = {}): Habit =>
      makeServerHabit({
        id: KEPT_HABIT_ID,
        name: MEDITATE,
        stage: 'Beige',
        revealed: true,
        streak: 9,
        energy_cost: 1,
        energy_return: 3,
        completions: [{ timestamp: new Date('2025-02-01'), completed_units: 1 }],
        goals: makeHabit().goals.map((g, i) => ({ ...g, id: KEPT_GOAL_IDS[i]! })),
        ...overrides,
      });

    afterEach(() => {
      // ``jest.clearAllMocks`` clears calls but keeps implementations, so a
      // case that reprograms a boundary has to hand it back.
      (habitsApi.create as jest.Mock).mockImplementation(() => Promise.resolve({}));
      (habitsApi.delete as jest.Mock).mockImplementation(() => Promise.resolve({}));
      useProgramStore.getState().hydrateProgramStartDate(null);
    });

    it('re-entering a habit the user already has PUTs the existing row instead of POSTing a name the server rejects', async () => {
      useHabitStore.setState({ habits: [keptHabit()] });

      const inFlight = habitManager.onboardingSave(
        [pick({ energy_cost: 4, energy_return: 2 })],
        jest.fn(),
      );
      // Read before awaiting: the scaffold used to replace the store for the
      // whole window between the optimistic write and the trailing reload.
      const beforeReload = useHabitStore.getState().habits[0]!;
      await inFlight;

      expect(habitsApi.update).toHaveBeenCalledWith(
        KEPT_HABIT_ID,
        expect.objectContaining({
          name: MEDITATE,
          energy_cost: 4,
          energy_return: 2,
          stage: 'Purple',
          start_date: '2026-01-01',
          sort_order: 0,
          revealed: true,
        }),
      );
      expect(habitsApi.create).not.toHaveBeenCalled();
      expect(beforeReload.id).toBe(KEPT_HABIT_ID);
      expect(beforeReload.streak).toBe(9);
      expect(beforeReload.completions).toHaveLength(1);
      expect(beforeReload.goals.map((g) => g.id)).toEqual(KEPT_GOAL_IDS);
      expect(beforeReload.revealed).toBe(true);
      expect(beforeReload.hasClientMintedIds).not.toBe(true);
    });

    it('re-entering a carryover keeps it on the negative lap with its own start date', async () => {
      useHabitStore.setState({
        habits: [
          makeServerHabit({
            id: CARRYOVER_ID,
            name: EVENING_READ,
            stage: 'Beige',
            is_carryover: true,
            start_date: CARRYOVER_START,
          }),
        ],
      });

      await habitManager.onboardingSave([pick({ name: EVENING_READ, energy_cost: 4 })], jest.fn());

      expect(habitsApi.create).not.toHaveBeenCalled();
      expect(habitsApi.update).toHaveBeenCalledWith(
        CARRYOVER_ID,
        expect.objectContaining({
          is_carryover: true,
          start_date: '2020-03-04',
          stage: 'Beige',
          energy_cost: 4,
        }),
      );
      const negativeLap = buildPagedHabits(useHabitStore.getState().habits, -1, 10);
      expect(negativeLap.habits.map((h) => h.id)).toEqual([CARRYOVER_ID]);
    });

    it('retains an existing habit the picks never name instead of releasing it', async () => {
      useHabitStore.setState({
        habits: [keptHabit(), makeServerHabit({ id: 48, name: 'Walk', sort_order: 1 })],
      });

      await habitManager.onboardingSave([pick({ energy_cost: 4 })], jest.fn());

      expect(habitsApi.delete).not.toHaveBeenCalled();
      expect(cancelForHabit).not.toHaveBeenCalled();
      expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([KEPT_HABIT_ID, 48]);
      expect(habitsApi.update).toHaveBeenCalledTimes(1);
      expect(habitsApi.update).toHaveBeenCalledWith(
        KEPT_HABIT_ID,
        expect.objectContaining({ energy_cost: 4 }),
      );
    });

    it('issues no wire call at all when the picks change nothing', async () => {
      useHabitStore.setState({
        habits: [keptHabit({ sort_order: 0, stage: 'Purple', start_date: PICK_START })],
      });

      await habitManager.onboardingSave([pick({ energy_cost: 1, energy_return: 3 })], jest.fn());

      expect(habitsApi.update).not.toHaveBeenCalled();
      expect(habitsApi.create).not.toHaveBeenCalled();
      expect(habitsApi.delete).not.toHaveBeenCalled();
    });

    it('mints new ids above the rows it kept and never addresses a demo tile', async () => {
      useHabitStore.setState({
        habits: [makeDemoHabit({ id: 3, name: 'Sample' }), keptHabit()],
      });

      await habitManager.onboardingSave(
        [pick({ energy_cost: 4 }), pick({ id: 'b', name: 'Sample' })],
        jest.fn(),
      );

      // The demo tile shares its fabricated id with nobody's real row here, but
      // it is the id the guard exists for: it must reach neither PUT nor DELETE.
      expect(habitsApi.update).not.toHaveBeenCalledWith(3, expect.anything());
      expect(habitsApi.delete).not.toHaveBeenCalled();
      expect(habitsApi.create).toHaveBeenCalledTimes(1);
      const minted = useHabitStore.getState().habits.find((h) => h.name === 'Sample')!;
      expect(minted.id).toBeGreaterThan(KEPT_HABIT_ID);
      expect(minted.goals.every((g) => g.id! > KEPT_GOAL_IDS[2]!)).toBe(true);
      expect(minted.hasClientMintedIds).toBe(true);
    });

    it('awaits the DELETE of a released name before POSTing a new habit that reuses it', async () => {
      let deleteResolved = false;
      let createSawDeleteResolved: boolean | null = null;
      (habitsApi.delete as jest.Mock).mockImplementation(() =>
        Promise.resolve().then(() => {
          deleteResolved = true;
        }),
      );
      (habitsApi.create as jest.Mock).mockImplementation(() => {
        createSawDeleteResolved = deleteResolved;
        return Promise.resolve({});
      });
      useHabitStore.setState({ habits: [keptHabit()] });

      const plan: HabitMergePlan = [
        { kind: 'released', habitId: KEPT_HABIT_ID },
        { kind: 'new', habit: pick() },
      ];
      await habitManager.onboardingSave(plan, jest.fn());

      expect(habitsApi.delete).toHaveBeenCalledWith(KEPT_HABIT_ID);
      expect(createSawDeleteResolved).toBe(true);
      expect(cancelForHabit).toHaveBeenCalledWith(KEPT_HABIT_ID);
    });

    it('releasing a demo tile cancels its reminders locally and sends no DELETE', async () => {
      useHabitStore.setState({ habits: [makeDemoHabit({ id: 3, name: 'Sample' })] });

      await habitManager.onboardingSave([{ kind: 'released', habitId: 3 }], jest.fn());

      expect(habitsApi.delete).not.toHaveBeenCalled();
      expect(cancelForHabit).toHaveBeenCalledWith(3);
    });

    it('a failed release puts back only that habit and leaves the rest of the merge standing', async () => {
      (habitsApi.delete as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);
      useHabitStore.setState({
        habits: [
          keptHabit(),
          makeServerHabit({ id: 48, name: 'Walk' }),
          makeServerHabit({ id: 49, name: 'Stretch' }),
        ],
      });

      const plan: HabitMergePlan = [
        { kind: 'released', habitId: KEPT_HABIT_ID },
        { kind: 'released', habitId: 48 },
        { kind: 're-rated', habitId: 49, habit: pick({ name: 'Stretch', energy_cost: 4 }) },
      ];
      await habitManager.onboardingSave(plan, jest.fn());

      const stored = useHabitStore.getState().habits;
      expect(stored.map((h) => h.id).sort((a, b) => a - b)).toEqual([KEPT_HABIT_ID, 49]);
      expect(stored.find((h) => h.id === 49)!.energy_cost).toBe(4);
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).toHaveBeenCalledTimes(1);
    });

    it('anchors the program to the picks, never to a carryover the pass brought along', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);
      useHabitStore.setState({
        habits: [
          makeServerHabit({
            id: CARRYOVER_ID,
            name: EVENING_READ,
            is_carryover: true,
            start_date: CARRYOVER_START,
          }),
        ],
      });

      await habitManager.onboardingSave(
        [
          pick({ name: EVENING_READ, start_date: new Date('2026-01-01') }),
          pick({ id: 'b', name: MEDITATE, start_date: new Date('2026-01-22') }),
        ],
        jest.fn(),
      );

      const anchor = useProgramStore.getState().programStartDate!;
      expect(anchor).not.toBeNull();
      expect(anchor.getFullYear()).toBe(2026);
      expect(anchor.getMonth()).toBe(0);
      expect(anchor.getDate()).toBe(1);
    });

    it('walks a mixed pass through delete, update and create with exact call counts', async () => {
      useHabitStore.setState({
        habits: [
          keptHabit(),
          makeServerHabit({ id: 48, name: 'Walk' }),
          makeServerHabit({
            id: 49,
            name: EVENING_READ,
            is_carryover: true,
            start_date: CARRYOVER_START,
          }),
          makeServerHabit({ id: 50, name: 'Stretch' }),
        ],
      });

      const plan: HabitMergePlan = [
        { kind: 're-rated', habitId: KEPT_HABIT_ID, habit: pick({ energy_cost: 4 }) },
        { kind: 'brought-along', habitId: 49, habit: pick({ id: 'c', name: EVENING_READ }) },
        { kind: 'new', habit: pick({ id: 'd', name: 'Breathe' }) },
        { kind: 'released', habitId: 48 },
        { kind: 'retained', habitId: 50 },
      ];
      await habitManager.onboardingSave(plan, jest.fn());

      expect(habitsApi.delete).toHaveBeenCalledTimes(1);
      expect(habitsApi.delete).toHaveBeenCalledWith(48);
      expect(habitsApi.create).toHaveBeenCalledTimes(1);
      const updated = (habitsApi.update as jest.Mock).mock.calls.map((c) => c[0] as number);
      expect(updated.sort((a, b) => a - b)).toEqual([KEPT_HABIT_ID, 49, 50]);
      expect(useHabitStore.getState().habits.map((h) => h.name)).toEqual([
        MEDITATE,
        EVENING_READ,
        'Breathe',
        'Stretch',
      ]);
    });

    describe('the cache the trailing reload reads back', () => {
      /** The on-disk cache, echoed: what the merge persists is what the reload reads. */
      let cache: Habit[] | null = null;

      beforeEach(() => {
        cache = null;
        (loadHabits as jest.Mock).mockImplementation(() => Promise.resolve(cache));
        (saveHabits as jest.Mock).mockImplementation((...args: unknown[]) => {
          cache = args[0] as Habit[];
          return Promise.resolve(undefined);
        });
      });

      afterEach(() => {
        (loadHabits as jest.Mock).mockImplementation(() => Promise.resolve(null));
        (saveHabits as jest.Mock).mockImplementation(() => Promise.resolve(undefined));
      });

      it('a release-everything pass stays released across the reload', async () => {
        // The cache the previous session wrote. Without a persist of the merged
        // list, loadHabits' stuck-user recovery reads this back and re-POSTs
        // every habit the user just released.
        cache = [keptHabit()];
        useHabitStore.setState({ habits: [keptHabit()] });

        await habitManager.onboardingSave(
          [{ kind: 'released', habitId: KEPT_HABIT_ID }],
          jest.fn(),
        );

        expect(habitsApi.create).not.toHaveBeenCalled();
        expect(cache).toEqual([]);
        expect(useHabitStore.getState().habits.every((h) => h.isDemoSeed === true)).toBe(true);
      });

      it('a first run whose creates all failed retries them through the stuck-user recovery', async () => {
        (habitsApi.create as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await habitManager.onboardingSave([pick()], jest.fn());

        expect(habitsApi.create).toHaveBeenCalledTimes(2);
        errorSpy.mockRestore();
      });
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

    it('revealAllHabits unlocks demo tiles locally without PUTting their fabricated ids', async () => {
      useHabitStore.setState({
        habits: [
          makeHabit({ id: 1, isDemoSeed: true, revealed: false }),
          makeHabit({ id: 2, isDemoSeed: true, revealed: false }),
        ],
      });

      habitManager.revealAllHabits();
      await Promise.resolve();

      expect(useHabitStore.getState().habits.map((h) => h.revealed)).toEqual([true, true]);
      expect(habitsApi.update).not.toHaveBeenCalled();
      const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('revealAllHabits PUTs only the server-backed row when demo tiles sit beside it', async () => {
      // id 42 sits outside the demo seed's 1..10 range, so the assertion cannot pass by coincidence.
      useHabitStore.setState({
        habits: [
          makeHabit({ id: 1, isDemoSeed: true, revealed: false }),
          makeHabit({ id: 42, revealed: false }),
        ],
      });

      habitManager.revealAllHabits();
      await Promise.resolve();

      expect(habitsApi.update).toHaveBeenCalledTimes(1);
      expect(habitsApi.update).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ revealed: true }),
      );
      expect(useHabitStore.getState().habits.map((h) => h.revealed)).toEqual([true, true]);
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
    it('rejects and skips the API call when the current goal has no server id', async () => {
      const habit = makeHabit();
      habit.goals = habit.goals.map((g) => (g.tier === 'low' ? { ...g, id: undefined } : g));
      useHabitStore.setState({ habits: [habit] });
      const ctx = habitManager.prepareLogUnit(1, 1, 'UTC')!;

      await expect(habitManager.commitLogUnitContext(ctx)).rejects.toThrow();

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

  describe('program anchor ignores carryover habits', () => {
    // A carryover habit is one the user brought along from before the program:
    // it is dated when they actually started it, so it records their own
    // history rather than the program's beginning. The universal anchor drives
    // Map, Practice, Course and Journal, so letting the oldest brought-along
    // row win drags every one of those screens backwards.
    const BEIGE = '2026-06-01';
    const BEFORE_BEIGE = '2026-01-15';
    const AFTER_BEIGE = '2026-09-01';
    // One stage later: where a reorder pass used to push the first program
    // habit when a carryover row took the picked date ahead of it.
    const SHIFTED_ONE_STAGE = '2026-06-22';

    /** A raw API row in the shape ``mapApiHabits`` consumes. */
    const apiRow = (id: number, name: string, startDate: string, carryover?: boolean) => ({
      id,
      name,
      icon: '\u{1F9D8}',
      start_date: startDate,
      energy_cost: 1,
      energy_return: 2,
      stage: 'Beige',
      streak: 0,
      milestone_notifications: false,
      goals: [],
      ...(carryover === undefined ? {} : { is_carryover: carryover }),
    });

    /** A cached row in the shape ``loadCachedHabits`` hands back. */
    const cachedRow = (id: number, startDate: string, carryover?: boolean): Habit =>
      makeHabit({
        id,
        start_date: new Date(startDate),
        ...(carryover === undefined ? {} : { is_carryover: carryover }),
      });

    const expectAnchorOn = (isoDate: string): void => {
      const anchor = useProgramStore.getState().programStartDate;
      const expected = new Date(isoDate);
      expect(anchor).not.toBeNull();
      expect(anchor!.getFullYear()).toBe(expected.getUTCFullYear());
      expect(anchor!.getMonth()).toBe(expected.getUTCMonth());
      expect(anchor!.getDate()).toBe(expected.getUTCDate());
    };

    const loadFromApi = async (rows: ReturnType<typeof apiRow>[]): Promise<void> => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce(rows as never);
      await habitManager.loadHabits();
    };

    it('keeps the anchor on a future Beige date when a carryover habit dated earlier loads', async () => {
      // The reachable bug: the picker's minimum is today, so a user who chose a
      // future Beige date and then brought a habit along today gets a row dated
      // before the anchor, and the next load re-anchors the whole program to it.
      useProgramStore.getState().hydrateProgramStartDate(new Date(BEIGE));

      await loadFromApi([
        apiRow(1, 'Survive', BEIGE),
        apiRow(2, 'Morning pages', BEFORE_BEIGE, true),
      ]);

      expectAnchorOn(BEIGE);
    });

    it('derives the anchor from the earliest program habit, not an earlier carryover habit', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);

      await loadFromApi([
        apiRow(1, 'Survive', BEIGE),
        apiRow(2, 'Morning pages', BEFORE_BEIGE, true),
      ]);

      expectAnchorOn(BEIGE);
    });

    it('finds no anchor at all in a store of nothing but carryover habits', async () => {
      // Absent anchor, so the self-heal is free to write: what stops it is the
      // exclusion emptying the set it derives from. A brought-along habit is
      // not a program date, so there is no program date here to find.
      useProgramStore.getState().hydrateProgramStartDate(null);

      await loadFromApi([
        apiRow(1, 'Morning pages', BEFORE_BEIGE, true),
        apiRow(2, 'Evening walk', BEFORE_BEIGE, true),
      ]);

      expect(useProgramStore.getState().programStartDate).toBeNull();
    });

    it('does not overwrite the date the user picked when the rows disagree with it', async () => {
      // The reorder-restamp aftermath, and the reason a derived anchor may not
      // outrank an explicit one. Rows already written by an older reorder pass
      // put the picked date on a carryover row and pushed the first program
      // habit a stage later. Excluding the carryover row leaves the derivation
      // reading one stage late -- so it must not be allowed to overwrite the
      // pick that is already stored.
      useProgramStore.getState().hydrateProgramStartDate(new Date(BEIGE));

      await loadFromApi([
        apiRow(1, 'Morning pages', BEIGE, true),
        apiRow(2, 'Survive', SHIFTED_ONE_STAGE),
      ]);

      expectAnchorOn(BEIGE);
    });

    it('ignores a cached carryover habit when the habits fetch fails', async () => {
      // The offline entry point: the anchor is re-derived from whatever the
      // store holds, and on a failed fetch that is the on-disk cache, which
      // carries the carryover flag through untouched.
      useProgramStore.getState().hydrateProgramStartDate(null);
      (loadHabits as jest.Mock).mockResolvedValueOnce([
        cachedRow(1, BEIGE),
        cachedRow(2, BEFORE_BEIGE, true),
      ] as never);
      (habitsApi.listAll as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);

      await habitManager.loadHabits();

      expectAnchorOn(BEIGE);
    });

    it('does not re-set the anchor when the only older habits are carryover habits', async () => {
      // Spied on the action the sync actually reaches for, not on the store's
      // ``setState``: the store closes over its own setter at creation, so a
      // spy installed on the store object is never the function an action calls.
      useProgramStore.getState().hydrateProgramStartDate(new Date(BEIGE));
      const setAnchorSpy = jest.spyOn(useProgramStore.getState(), 'setProgramStartDate');

      await loadFromApi([
        apiRow(1, 'Survive', BEIGE),
        apiRow(2, 'Morning pages', BEFORE_BEIGE, true),
      ]);

      expect(setAnchorSpy).not.toHaveBeenCalled();
      setAnchorSpy.mockRestore();
    });

    it('keeps a re-scaffolded Beige date through the reload that follows onboardingSave', async () => {
      useProgramStore.getState().hydrateProgramStartDate(new Date('2020-01-01'));
      const newHabits: OnboardingHabit[] = [
        {
          id: 'a',
          name: 'Survive',
          icon: '\u{1F9D8}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Beige',
          start_date: new Date(BEIGE),
        },
      ];
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        apiRow(1, 'Survive', BEIGE),
        apiRow(2, 'Morning pages', BEFORE_BEIGE, true),
      ] as never);

      await habitManager.onboardingSave(newHabits);

      expectAnchorOn(BEIGE);
    });

    // Characterisation only: this passes without the exclusion, because a min
    // over both rows already returns the program one. It pins the ordering so a
    // later filter cannot start preferring the carryover row.
    it('is unperturbed by a carryover habit dated after the program habit', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);

      await loadFromApi([
        apiRow(1, 'Survive', BEIGE),
        apiRow(2, 'Morning pages', AFTER_BEIGE, true),
      ]);

      expectAnchorOn(BEIGE);
    });

    // Characterisation only. The inbound mapper passes the flag through with no
    // default, so every row written before carryover existed arrives with it
    // absent. Absent must keep anchoring, or the majority of real rows would
    // silently fall outside the anchor.
    it('still anchors to a habit whose carryover flag is absent rather than false', async () => {
      useProgramStore.getState().hydrateProgramStartDate(null);

      await loadFromApi([apiRow(1, 'Survive', BEIGE)]);

      expect(useHabitStore.getState().habits[0]!.is_carryover).toBeUndefined();
      expectAnchorOn(BEIGE);
    });

    // Characterisation only: pins the call shape the re-scaffold rewrite will
    // inherit. A chosen date wins even over an anchor that is already set --
    // there is no monotonic or already-set guard, and adding one would break
    // re-scaffolding to an earlier date.
    it('anchors onboardingSave to the chosen Beige date even when an anchor already exists', async () => {
      useProgramStore.getState().hydrateProgramStartDate(new Date('2020-01-01'));
      const newHabits: OnboardingHabit[] = [
        {
          id: 'b',
          name: 'Belong',
          icon: '\u{1F49C}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Purple',
          start_date: new Date('2026-06-22'),
        },
        {
          id: 'a',
          name: 'Survive',
          icon: '\u{1F9D8}',
          energy_cost: 1,
          energy_return: 3,
          stage: 'Beige',
          start_date: new Date(BEIGE),
        },
      ];

      await habitManager.onboardingSave(newHabits);

      expectAnchorOn(BEIGE);
    });
  });

  describe('demo-seed tiles never persist and never recover', () => {
    // The demo seed is an in-memory placeholder for a user with no server
    // habits. Once it reaches the AsyncStorage cache, the next launch reads it
    // back as real data and stuck-user recovery POSTs it, minting fabricated
    // server habits. It must never be written, and never be recovered.
    const seedDemoTiles = async (): Promise<void> => {
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      await habitManager.loadHabits();
    };

    /** Server row shape returned by the post-recovery re-fetch. */
    const serverHabit = (id: number, name: string) => ({
      id,
      name,
      icon: '\u{1F9D8}',
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
    });

    it('updateGoal on a demo tile writes no demo tile to the cache', async () => {
      await seedDemoTiles();
      const tile = useHabitStore.getState().habits[0]!;

      habitManager.updateGoal(tile.id, { ...tile.goals[0]!, target: 42 });

      expect(lastPersisted()).toEqual([]);
      // The write itself still happens: it heals a cache poisoned before the guard.
      expect(saveHabits).toHaveBeenCalledWith([]);
    });

    it('updateHabit on a demo tile writes no demo tile to the cache', async () => {
      await seedDemoTiles();
      const tile = useHabitStore.getState().habits[0]!;

      habitManager.updateHabit({ ...tile, name: 'Renamed' });
      // The notification reschedule persists asynchronously.
      await new Promise((resolve) => setImmediate(resolve));

      expect(lastPersisted()).toEqual([]);
      expect(saveHabits).toHaveBeenCalledWith([]);
    });

    it('the logUnit pipeline on a demo tile writes no demo tile to the cache', async () => {
      await seedDemoTiles();
      const tile = useHabitStore.getState().habits[0]!;

      const ctx = habitManager.prepareLogUnit(tile.id, 1, 'UTC')!;
      habitManager.applyLogUnitContext(ctx);

      expect(lastPersisted()).toEqual([]);
      expect(saveHabits).toHaveBeenCalledWith([]);
    });

    it('a mixed store persists the real habit and drops the demo tiles', () => {
      useHabitStore.setState({
        habits: [...CACHED_DEMO_TILES, makeHabit({ id: 42, name: 'Real' })],
      });
      const real = useHabitStore.getState().habits.find((h) => h.id === 42)!;

      habitManager.updateGoal(real.id, { ...real.goals[0]!, target: 30 });

      expect(lastPersisted().map((h) => h.name)).toEqual(['Real']);
    });

    it('does not recover demo tiles restored from an already-poisoned cache', async () => {
      // Caches written before this guard existed still hold demo tiles.
      (loadHabits as jest.Mock).mockResolvedValueOnce(CACHED_DEMO_TILES as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      expect(habitsApi.create).not.toHaveBeenCalled();
      expect(goalsApi.update).not.toHaveBeenCalled();
    });

    it('still recovers a genuinely stuck real habit cached beside demo tiles', async () => {
      const cachedReal = makeHabit({ id: 1, name: 'Real' });
      (loadHabits as jest.Mock).mockResolvedValueOnce([cachedReal, ...CACHED_DEMO_TILES] as never);
      (habitsApi.listAll as jest.Mock)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([serverHabit(99, 'Real')] as never);

      await habitManager.loadHabits();

      expect(habitsApi.create).toHaveBeenCalledTimes(1);
      expect(habitsApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Real' }));
    });

    it('a demo tile touched before a relaunch never becomes a server habit', async () => {
      await seedDemoTiles();
      const tile = useHabitStore.getState().habits[0]!;
      habitManager.updateGoal(tile.id, { ...tile.goals[0]!, target: 42 });
      const written = lastPersisted();

      // The relaunch: a cold store rehydrating from exactly what was written.
      resetStore();
      (loadHabits as jest.Mock).mockResolvedValueOnce(written as never);
      (habitsApi.listAll as jest.Mock)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never);

      await habitManager.loadHabits();

      expect(habitsApi.create).not.toHaveBeenCalled();
      // The offline demo UX survives the guard rather than being deleted.
      const shown = useHabitStore.getState().habits;
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((h) => h.isDemoSeed === true)).toBe(true);
    });
  });
  describe('non-server ids never reach the wire', () => {
    // Four id families share the store: demo placeholders (positive, demo-marked),
    // pre-sync added habits (negative), onboarding scaffold rows (positive, in the
    // server's own range), and genuinely server-backed rows.
    const DEMO_TILE_ID = 3;
    const NEW_ICON = '\u{1F525}';

    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    const demoTile = (overrides: Partial<Habit> = {}): Habit =>
      makeDemoHabit({ id: DEMO_TILE_ID, name: 'Sample', ...overrides });

    describe('deleteHabit', () => {
      it('removes a demo tile locally and cancels its reminders without a DELETE', () => {
        useHabitStore.setState({ habits: [demoTile()] });

        habitManager.deleteHabit(DEMO_TILE_ID);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits).toEqual([]);
        expect(cancelForHabit).toHaveBeenCalledWith(DEMO_TILE_ID);
      });

      it('removes a pre-sync added habit locally without a DELETE', () => {
        useHabitStore.setState({ habits: [makeSyntheticHabit()] });

        habitManager.deleteHabit(SYNTHETIC_HABIT_ID);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits).toEqual([]);
        expect(cancelForHabit).toHaveBeenCalledWith(SYNTHETIC_HABIT_ID);
      });

      it('removes a habit whose id is zero without a DELETE', () => {
        useHabitStore.setState({ habits: [makeHabit({ id: 0 })] });

        habitManager.deleteHabit(0);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits).toEqual([]);
        expect(cancelForHabit).toHaveBeenCalledWith(0);
      });

      it('DELETEs only the server-backed row when a demo tile sits beside it', () => {
        useHabitStore.setState({ habits: [demoTile(), makeServerHabit()] });

        habitManager.deleteHabit(SERVER_HABIT_ID);

        expect(habitsApi.delete).toHaveBeenCalledTimes(1);
        expect(habitsApi.delete).toHaveBeenCalledWith(SERVER_HABIT_ID);
        expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([DEMO_TILE_ID]);
      });

      it('cannot delete a real row through a demo tile seeded by an unreachable server', async () => {
        (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
        (habitsApi.listAll as jest.Mock).mockRejectedValueOnce(new Error('offline') as never);

        await habitManager.loadHabits();

        const seeded = useHabitStore.getState().habits;
        expect(seeded).toHaveLength(10);
        expect(seeded.filter((h) => h.isDemoSeed === true)).toHaveLength(10);

        habitManager.deleteHabit(seeded[0]!.id);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits).toHaveLength(9);
      });
    });

    describe('updateHabit', () => {
      it('renames a demo tile locally without PUTting its fabricated id', async () => {
        const tile = demoTile();
        useHabitStore.setState({ habits: [tile] });

        habitManager.updateHabit({ ...tile, name: 'Renamed' });
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.name).toBe('Renamed');
      });

      it('renames a pre-sync added habit locally without PUTting its negative id', async () => {
        const synthetic = makeSyntheticHabit();
        useHabitStore.setState({ habits: [synthetic] });

        habitManager.updateHabit({ ...synthetic, name: 'Renamed' });
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.name).toBe('Renamed');
      });

      it('PUTs only the server-backed row when a demo tile sits beside it', async () => {
        const real = makeServerHabit();
        useHabitStore.setState({ habits: [demoTile(), real] });

        habitManager.updateHabit({ ...real, name: 'Renamed' });
        await settle();

        expect(habitsApi.update).toHaveBeenCalledTimes(1);
        expect(habitsApi.update).toHaveBeenCalledWith(
          SERVER_HABIT_ID,
          expect.objectContaining({ name: 'Renamed' }),
        );
      });
    });

    describe('setEmojiForHabit', () => {
      it('changes a demo tile icon locally without PUTting its fabricated id', () => {
        useHabitStore.setState({ habits: [demoTile()] });

        habitManager.setEmojiForHabit(0, NEW_ICON);

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.icon).toBe(NEW_ICON);
      });

      it('changes a pre-sync added habit icon locally without PUTting its negative id', () => {
        useHabitStore.setState({ habits: [makeSyntheticHabit()] });

        habitManager.setEmojiForHabit(0, NEW_ICON);

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.icon).toBe(NEW_ICON);
      });

      it('PUTs the new icon only for the server-backed row at that index', () => {
        useHabitStore.setState({ habits: [demoTile(), makeServerHabit()] });

        habitManager.setEmojiForHabit(1, NEW_ICON);

        expect(habitsApi.update).toHaveBeenCalledTimes(1);
        expect(habitsApi.update).toHaveBeenCalledWith(
          SERVER_HABIT_ID,
          expect.objectContaining({ icon: NEW_ICON }),
        );
      });
    });

    describe('setNewStartDate', () => {
      const NEW_START = new Date('2026-03-01T00:00:00Z');

      const withHistory = (habit: Habit): Habit => ({
        ...habit,
        streak: 5,
        completions: [{ timestamp: new Date('2025-02-01T00:00:00Z'), completed_units: 1 }],
      });

      it('resets a demo tile locally without a PUT and without clearing server check-ins', async () => {
        useHabitStore.setState({ habits: [withHistory(demoTile())] });

        habitManager.setNewStartDate(DEMO_TILE_ID, NEW_START);
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(habitsApi.clearCompletions).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.streak).toBe(0);
        expect(stored.completions).toEqual([]);
      });

      it('resets a pre-sync added habit locally without a PUT and without clearing check-ins', async () => {
        useHabitStore.setState({ habits: [withHistory(makeSyntheticHabit())] });

        habitManager.setNewStartDate(SYNTHETIC_HABIT_ID, NEW_START);
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(habitsApi.clearCompletions).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.streak).toBe(0);
        expect(stored.completions).toEqual([]);
      });

      it('PUTs then clears check-ins only for the server-backed row', async () => {
        useHabitStore.setState({ habits: [demoTile(), withHistory(makeServerHabit())] });

        habitManager.setNewStartDate(SERVER_HABIT_ID, NEW_START);
        await settle();

        expect(habitsApi.update).toHaveBeenCalledTimes(1);
        expect(habitsApi.update).toHaveBeenCalledWith(
          SERVER_HABIT_ID,
          expect.objectContaining({ start_date: '2026-03-01' }),
        );
        expect(habitsApi.clearCompletions).toHaveBeenCalledTimes(1);
        expect(habitsApi.clearCompletions).toHaveBeenCalledWith(SERVER_HABIT_ID);
      });
    });

    describe('updateGoalUnits', () => {
      const MINUTES = ['minutes', 'minutes', 'minutes'];

      it('applies new units to a demo tile locally without a batch PUT', () => {
        useHabitStore.setState({ habits: [demoTile()] });

        habitManager.updateGoalUnits(DEMO_TILE_ID, { target_unit: 'minutes' });

        expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals.map((g) => g.target_unit)).toEqual(
          MINUTES,
        );
      });

      it('applies new units to a pre-sync added habit locally without a batch PUT', () => {
        useHabitStore.setState({ habits: [makeSyntheticHabit()] });

        habitManager.updateGoalUnits(SYNTHETIC_HABIT_ID, { target_unit: 'minutes' });

        expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals.map((g) => g.target_unit)).toEqual(
          MINUTES,
        );
      });

      it('refuses a server-backed habit whose tier goals still carry negative ids', () => {
        const straggler = makeServerHabit({
          goals: makeHabit().goals.map((g, i) => ({ ...g, id: SYNTHETIC_HABIT_ID - i - 1 })),
        });
        useHabitStore.setState({ habits: [straggler] });

        habitManager.updateGoalUnits(SERVER_HABIT_ID, { target_unit: 'minutes' });

        expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals.map((g) => g.target_unit)).toEqual(
          MINUTES,
        );
      });

      it('PUTs the batch only for the server-backed row', () => {
        useHabitStore.setState({ habits: [demoTile(), makeServerHabit()] });

        habitManager.updateGoalUnits(SERVER_HABIT_ID, { target_unit: 'minutes' });

        expect(habitsApi.updateGoalUnits).toHaveBeenCalledTimes(1);
        expect(habitsApi.updateGoalUnits).toHaveBeenCalledWith(
          SERVER_HABIT_ID,
          expect.objectContaining({ target_unit: 'minutes' }),
        );
      });
    });

    describe('updateGoal', () => {
      const NEW_TARGET = 42;

      it('edits a demo tile goal locally without PUTting the goal', () => {
        const tile = demoTile();
        useHabitStore.setState({ habits: [tile] });

        habitManager.updateGoal(DEMO_TILE_ID, { ...tile.goals[0]!, target: NEW_TARGET });

        expect(goalsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals[0]!.target).toBe(NEW_TARGET);
      });

      it('edits a pre-sync added habit goal locally without PUTting the goal', () => {
        const synthetic = makeSyntheticHabit();
        useHabitStore.setState({ habits: [synthetic] });

        habitManager.updateGoal(SYNTHETIC_HABIT_ID, { ...synthetic.goals[0]!, target: NEW_TARGET });

        expect(goalsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals[0]!.target).toBe(NEW_TARGET);
      });

      it('PUTs the goal only when its parent habit is server-backed', () => {
        const real = makeServerHabit();
        useHabitStore.setState({ habits: [demoTile(), real] });

        habitManager.updateGoal(SERVER_HABIT_ID, { ...real.goals[0]!, target: NEW_TARGET });

        expect(goalsApi.update).toHaveBeenCalledTimes(1);
        expect(goalsApi.update).toHaveBeenCalledWith(
          SERVER_GOAL_IDS[0],
          expect.objectContaining({ target: NEW_TARGET }),
        );
      });
    });

    describe('commitLogUnitContext', () => {
      it('keeps a demo tile log local and posts no goal completion', async () => {
        useHabitStore.setState({ habits: [demoTile()] });
        const ctx = habitManager.prepareLogUnit(DEMO_TILE_ID, 1, 'UTC')!;
        habitManager.applyLogUnitContext(ctx);

        const result = await habitManager.commitLogUnitContext(ctx);

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        expect(result).toBeNull();
        expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);
      });

      it('rejects a pre-sync added habit log instead of posting its synthetic goal id', async () => {
        // The marker now drives the stale-scaffold resync the 404 used to.
        useHabitStore.setState({ habits: [makeSyntheticHabit()] });
        const ctx = habitManager.prepareLogUnit(SYNTHETIC_HABIT_ID, 1, 'UTC')!;
        habitManager.applyLogUnitContext(ctx);

        await expect(habitManager.commitLogUnitContext(ctx)).rejects.toThrow();

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        expect(postedGoalIds()).toEqual([]);
      });

      it('posts the server goal id when a demo tile sits beside the real row', async () => {
        useHabitStore.setState({ habits: [demoTile(), makeServerHabit()] });
        const ctx = habitManager.prepareLogUnit(SERVER_HABIT_ID, 1, 'UTC')!;
        habitManager.applyLogUnitContext(ctx);

        await habitManager.commitLogUnitContext(ctx);

        expect(postedGoalIds()).toEqual([SERVER_GOAL_IDS[0]]);
      });

      it('posts the server goal id when a scaffold row sits beside the real row', async () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit(), makeServerHabit()] });
        const ctx = habitManager.prepareLogUnit(SERVER_HABIT_ID, 1, 'UTC')!;
        habitManager.applyLogUnitContext(ctx);

        await habitManager.commitLogUnitContext(ctx);

        expect(postedGoalIds()).toEqual([SERVER_GOAL_IDS[0]]);
      });
    });

    describe('backfillMissedDays', () => {
      const MISSED_DAY = new Date('2025-06-01T12:00:00Z');

      it('keeps a demo tile backfill local and posts no completions', () => {
        useHabitStore.setState({ habits: [demoTile()] });

        habitManager.backfillMissedDays(DEMO_TILE_ID, [MISSED_DAY], 'UTC');

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.completions).toHaveLength(1);
        expect(stored.streak).toBe(1);
      });

      it('keeps a pre-sync added habit backfill local and posts no completions', () => {
        useHabitStore.setState({ habits: [makeSyntheticHabit()] });

        habitManager.backfillMissedDays(SYNTHETIC_HABIT_ID, [MISSED_DAY], 'UTC');

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.completions).toHaveLength(1);
        expect(stored.streak).toBe(1);
      });

      it('posts one completion against the low goal of the server-backed row', () => {
        useHabitStore.setState({ habits: [demoTile(), makeServerHabit()] });

        habitManager.backfillMissedDays(SERVER_HABIT_ID, [MISSED_DAY], 'UTC');

        expect(goalCompletionsApi.create).toHaveBeenCalledTimes(1);
        expect(goalCompletionsApi.create).toHaveBeenCalledWith({
          goal_id: SERVER_GOAL_IDS[0],
          did_complete: true,
          completed_on: '2025-06-01',
        });
      });
    });

    describe('syncRevealState', () => {
      it('unlocks a pre-sync added habit locally without PUTting its negative id', () => {
        useHabitStore.setState({ habits: [makeSyntheticHabit({ revealed: false })] });

        habitManager.revealAllHabits();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.revealed).toBe(true);
      });

      it('still PUTs every row when the whole store is server-backed', () => {
        useHabitStore.setState({
          habits: [42, 43, 44].map((id) => makeServerHabit({ id, revealed: false })),
        });

        habitManager.revealAllHabits();

        expect(habitsApi.update).toHaveBeenCalledTimes(3);
        expect(useHabitStore.getState().habits.map((h) => h.revealed)).toEqual([true, true, true]);
      });
    });

    describe('saveHabitOrder', () => {
      it('reorders pre-sync added habits locally without PUTting their negative ids', () => {
        const first = makeSyntheticHabit({ name: 'First' });
        const second = makeSyntheticHabit({ id: SYNTHETIC_HABIT_ID - 100, name: 'Second' });
        useHabitStore.setState({ habits: [first, second] });

        habitManager.saveHabitOrder([second, first]);

        expect(habitsApi.update).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits;
        expect(stored.map((h) => h.name)).toEqual(['Second', 'First']);
        expect(stored.map((h) => h.sort_order)).toEqual([0, 1]);
      });

      it('still PUTs every row of a reorder when the whole store is server-backed', () => {
        const rows = [42, 43, 44].map((id) => makeServerHabit({ id, name: `Real ${id}` }));
        useHabitStore.setState({ habits: rows });

        habitManager.saveHabitOrder([rows[2]!, rows[0]!, rows[1]!]);

        expect(habitsApi.update).toHaveBeenCalledTimes(3);
        expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([44, 42, 43]);
      });
    });

    describe('an onboarding scaffold row whose positive ids this device minted', () => {
      const NEW_START = new Date('2026-03-01T00:00:00Z');
      const MISSED_DAY = new Date('2025-06-01T12:00:00Z');
      const MINUTES_UNIT = 'minutes';
      const ALL_MINUTES = [MINUTES_UNIT, MINUTES_UNIT, MINUTES_UNIT];
      const NEW_TARGET = 42;

      it("deletes locally and cancels its reminders without DELETEing the caller's real row", () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit()] });

        habitManager.deleteHabit(SCAFFOLD_HABIT_ID);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits).toEqual([]);
        expect(cancelForHabit).toHaveBeenCalledWith(SCAFFOLD_HABIT_ID);
      });

      it('DELETEs the server-backed sibling but never the scaffold row', () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit(), makeServerHabit()] });

        habitManager.deleteHabit(SCAFFOLD_HABIT_ID);

        expect(habitsApi.delete).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits.map((h) => h.id)).toEqual([SERVER_HABIT_ID]);

        habitManager.deleteHabit(SERVER_HABIT_ID);

        expect(habitsApi.delete).toHaveBeenCalledTimes(1);
        expect(habitsApi.delete).toHaveBeenCalledWith(SERVER_HABIT_ID);
      });

      it('resets the start date locally without a PUT and without clearing check-ins', async () => {
        useHabitStore.setState({
          habits: [
            makeScaffoldHabit({
              streak: 5,
              completions: [{ timestamp: new Date('2025-02-01T00:00:00Z'), completed_units: 1 }],
            }),
          ],
        });

        habitManager.setNewStartDate(SCAFFOLD_HABIT_ID, NEW_START);
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(habitsApi.clearCompletions).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.streak).toBe(0);
        expect(stored.completions).toEqual([]);
      });

      it('renames locally without PUTting its device-minted id', async () => {
        const scaffold = makeScaffoldHabit();
        useHabitStore.setState({ habits: [scaffold] });

        habitManager.updateHabit({ ...scaffold, name: 'Renamed' });
        await settle();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.name).toBe('Renamed');
      });

      it('changes its icon locally without PUTting its device-minted id', () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit()] });

        habitManager.setEmojiForHabit(0, NEW_ICON);

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.icon).toBe(NEW_ICON);
      });

      it('edits a goal locally without PUTting its device-minted goal id', () => {
        const scaffold = makeScaffoldHabit();
        useHabitStore.setState({ habits: [scaffold] });

        habitManager.updateGoal(SCAFFOLD_HABIT_ID, { ...scaffold.goals[0]!, target: NEW_TARGET });

        expect(goalsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals[0]!.target).toBe(NEW_TARGET);
      });

      it('applies new units locally without a batch PUT', () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit()] });

        habitManager.updateGoalUnits(SCAFFOLD_HABIT_ID, { target_unit: MINUTES_UNIT });

        expect(habitsApi.updateGoalUnits).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.goals.map((g) => g.target_unit)).toEqual(
          ALL_MINUTES,
        );
      });

      it('unlocks locally without PUTting its device-minted id', () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit({ revealed: false })] });

        habitManager.revealAllHabits();

        expect(habitsApi.update).not.toHaveBeenCalled();
        expect(useHabitStore.getState().habits[0]!.revealed).toBe(true);
      });

      it('reorders locally without PUTting its device-minted id', () => {
        const first = makeScaffoldHabit({ name: 'First' });
        const second = makeScaffoldHabit({ id: SCAFFOLD_HABIT_ID + 1, name: 'Second' });
        useHabitStore.setState({ habits: [first, second] });

        habitManager.saveHabitOrder([second, first]);

        expect(habitsApi.update).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits;
        expect(stored.map((h) => h.name)).toEqual(['Second', 'First']);
        expect(stored.map((h) => h.sort_order)).toEqual([0, 1]);
      });

      it("keeps a backfill locally and posts no completion against a stranger's goal", () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit()] });

        habitManager.backfillMissedDays(SCAFFOLD_HABIT_ID, [MISSED_DAY], 'UTC');

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        const stored = useHabitStore.getState().habits[0]!;
        expect(stored.completions).toHaveLength(1);
        expect(stored.streak).toBe(1);
      });

      it("rejects a unit log instead of posting it against the caller's real goal", async () => {
        useHabitStore.setState({ habits: [makeScaffoldHabit()] });
        const ctx = habitManager.prepareLogUnit(SCAFFOLD_HABIT_ID, 1, 'UTC')!;
        habitManager.applyLogUnitContext(ctx);

        await expect(habitManager.commitLogUnitContext(ctx)).rejects.toThrow();

        expect(goalCompletionsApi.create).not.toHaveBeenCalled();
        expect(postedGoalIds()).toEqual([]);
      });

      it('reaches the on-disk cache even though a demo tile beside it does not', () => {
        useHabitStore.setState({
          habits: [
            makeScaffoldHabit({ revealed: false }),
            makeDemoHabit({ id: 5, name: 'Sample' }),
          ],
        });

        habitManager.revealAllHabits();

        expect(lastPersisted().map((h) => h.name)).toEqual(['Scaffold']);
      });
    });
  });

  describe('client-minted id provenance', () => {
    const onboardingHabit = (id: string, name: string, stage: string): OnboardingHabit => ({
      id,
      name,
      icon: '\u{1F9D8}',
      energy_cost: 1,
      energy_return: 3,
      stage,
      start_date: new Date('2025-01-01'),
    });

    it('marks every onboarding scaffold row before the trailing reload lands', async () => {
      const inFlight = habitManager.onboardingSave(
        [onboardingHabit('a', 'Meditate', 'Beige'), onboardingHabit('b', 'Journal', 'Purple')],
        jest.fn(),
      );

      const scaffolded = useHabitStore.getState().habits;
      expect(scaffolded).toHaveLength(2);
      expect(scaffolded.every((h) => h.hasClientMintedIds === true)).toBe(true);

      await inFlight;
    });

    it('marks the optimistically appended row of an add still in flight', async () => {
      useHabitStore.setState({ habits: [makeHabit({ id: 1, name: 'Existing' })] });
      let resolveCreate: (() => void) | undefined;
      (habitsApi.create as jest.Mock).mockImplementationOnce(
        () => new Promise<unknown>((r) => (resolveCreate = () => r({}))),
      );

      const inFlight = habitManager.addHabit({ name: 'Brand New', icon: '\u{1F195}' });

      const optimistic = useHabitStore.getState().habits;
      expect(optimistic).toHaveLength(2);
      expect(optimistic[1]!.hasClientMintedIds).toBe(true);

      resolveCreate?.();
      await inFlight;
    });

    it('carries no marker across a refresh that returns real server rows', async () => {
      useHabitStore.setState({ habits: [makeScaffoldHabit()] });
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 99,
          name: 'Scaffold',
          icon: '\u{1F9D8}',
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

      const stored = useHabitStore.getState().habits;
      expect(stored.map((h) => h.id)).toEqual([99]);
      expect(stored.every((h) => h.hasClientMintedIds === undefined)).toBe(true);
    });
  });

  describe('replayPendingCheckIns failure classification', () => {
    const queued = (goalId: number, day: string) => ({
      goal_id: goalId,
      did_complete: true,
      timestamp: `${day}T00:00:00Z`,
    });

    type QueuedCheckIn = ReturnType<typeof queued>;

    // Nothing in this store is demo-seed, so a demo-tile-only guard cannot satisfy these.
    const replay = async (pending: QueuedCheckIn[]): Promise<void> => {
      useHabitStore.setState({ habits: [makeHabit({ id: 7, name: 'Real' })] });
      (loadHabits as jest.Mock).mockResolvedValueOnce(null as never);
      (habitsApi.listAll as jest.Mock).mockResolvedValueOnce([] as never);
      (loadPendingCheckIns as jest.Mock).mockResolvedValueOnce(pending as never);
      await habitManager.loadHabits('UTC');
    };

    beforeEach(() => {
      // ``clearMocks`` drops calls but not a leftover ``Once`` queue, so reset it here.
      (goalCompletionsApi.create as jest.Mock).mockReset();
      (goalCompletionsApi.create as jest.Mock).mockResolvedValue({} as never);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('drops a permanently rejected entry and keeps draining the queue behind it', async () => {
      (goalCompletionsApi.create as jest.Mock)
        .mockRejectedValueOnce(new ApiError(404, 'goal_not_found') as never)
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({} as never);

      await replay([queued(77, '2025-04-01'), queued(88, '2025-04-02'), queued(99, '2025-04-03')]);

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(3);
      expect(postedGoalIds()).toEqual([77, 88, 99]);
      expect(clearPendingCheckIns).toHaveBeenCalled();
      expect(replacePendingCheckIns).not.toHaveBeenCalled();
    });

    it('posts a queued entry carrying a negative goal id and quarantines its rejection', async () => {
      // No current path can enqueue this id; the drain was given no new client-side filter.
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(404, 'goal_not_found') as never,
      );

      await replay([queued(SYNTHETIC_HABIT_ID - 1, '2025-04-01')]);

      expect(postedGoalIds()).toEqual([SYNTHETIC_HABIT_ID - 1]);
      expect(recordDroppedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ goal_id: SYNTHETIC_HABIT_ID - 1, status: 404 }),
      );
      expect(clearPendingCheckIns).toHaveBeenCalled();
    });

    it('re-queues the unposted suffix when a real ApiError is transient (BUG-FE-HABIT-205)', async () => {
      const pending = [queued(1, '2025-04-01'), queued(2, '2025-04-02'), queued(3, '2025-04-03')];
      (goalCompletionsApi.create as jest.Mock)
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(new ApiError(503, 'unavailable') as never);

      await replay(pending);

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(2);
      expect(clearPendingCheckIns).not.toHaveBeenCalled();
      expect(replacePendingCheckIns).toHaveBeenCalledWith([pending[1]!, pending[2]!]);
    });

    it('treats a 401 as transient because auth rehydrates on the next launch', async () => {
      const pending = [queued(21, '2025-04-01'), queued(22, '2025-04-02')];
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(401, 'Not authenticated') as never,
      );

      await replay(pending);

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(1);
      expect(clearPendingCheckIns).not.toHaveBeenCalled();
      expect(replacePendingCheckIns).toHaveBeenCalledWith([pending[0]!, pending[1]!]);
    });

    it('drops an ApiValidationError even when its status alone would read as transient', async () => {
      const pending = [queued(31, '2025-04-01'), queued(32, '2025-04-02')];
      (goalCompletionsApi.create as jest.Mock)
        .mockRejectedValueOnce(new ApiValidationError('/goal_completions/', 201, []) as never)
        .mockResolvedValueOnce({} as never);

      await replay(pending);

      expect(goalCompletionsApi.create).toHaveBeenCalledTimes(2);
      expect(postedGoalIds()).toEqual([31, 32]);
      expect(clearPendingCheckIns).toHaveBeenCalled();
      expect(replacePendingCheckIns).not.toHaveBeenCalled();
    });

    it('announces the dropped check-in with its goal id and status', async () => {
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(422, 'unprocessable') as never,
      );

      await replay([queued(4242, '2025-04-01')]);

      const warnMock = console.warn as unknown as jest.Mock;
      expect(warnMock).toHaveBeenCalledTimes(1);
      const logged = (warnMock.mock.calls[0] as unknown[]).map((arg) => String(arg)).join(' ');
      expect(logged).toContain('4242');
      expect(logged).toContain('422');
    });

    it('clears an all-permanent queue instead of wedging it forever', async () => {
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(400, 'bad_request') as never,
      );

      await replay([queued(51, '2025-04-01')]);

      expect(clearPendingCheckIns).toHaveBeenCalled();
      expect(replacePendingCheckIns).not.toHaveBeenCalled();
    });

    const requeuedSuffix = (): QueuedCheckIn[] => {
      const calls = (replacePendingCheckIns as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      return calls[0]![0] as QueuedCheckIn[];
    };

    it('quarantines a dropped entry with its goal id and status', async () => {
      (goalCompletionsApi.create as jest.Mock)
        .mockRejectedValueOnce(new ApiError(404, 'goal_not_found') as never)
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({} as never);

      await replay([queued(77, '2025-04-01'), queued(88, '2025-04-02'), queued(99, '2025-04-03')]);

      expect(recordDroppedCheckIn).toHaveBeenCalledTimes(1);
      expect(recordDroppedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({
          goal_id: 77,
          status: 404,
          did_complete: true,
          timestamp: '2025-04-01T00:00:00Z',
        }),
      );
      expect(postedGoalIds()).toEqual([77, 88, 99]);
    });

    it('does not quarantine a 503 outage and re-queues the entry instead', async () => {
      const pending = [queued(101, '2025-04-01'), queued(102, '2025-04-02')];
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(503, 'unavailable') as never,
      );

      await replay(pending);

      expect(recordDroppedCheckIn).not.toHaveBeenCalled();
      const requeued = requeuedSuffix();
      expect(requeued).toHaveLength(2);
      expect(requeued.map((c) => c.goal_id)).toEqual([101, 102]);
    });

    it('does not quarantine an expired token and re-queues the entry instead', async () => {
      const pending = [queued(111, '2025-04-01'), queued(112, '2025-04-02')];
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(401, 'Not authenticated') as never,
      );

      await replay(pending);

      expect(recordDroppedCheckIn).not.toHaveBeenCalled();
      const requeued = requeuedSuffix();
      expect(requeued).toHaveLength(2);
      expect(requeued.map((c) => c.goal_id)).toEqual([111, 112]);
    });

    it('quarantines an ApiValidationError drop with the status the response carried', async () => {
      (goalCompletionsApi.create as jest.Mock)
        .mockRejectedValueOnce(new ApiValidationError('/goal_completions/', 201, []) as never)
        .mockResolvedValueOnce({} as never);

      await replay([queued(31, '2025-04-01'), queued(32, '2025-04-02')]);

      expect(recordDroppedCheckIn).toHaveBeenCalledTimes(1);
      expect(recordDroppedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ goal_id: 31, status: 201 }),
      );
    });

    it('both announces and quarantines the same dropped check-in', async () => {
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(422, 'unprocessable') as never,
      );

      await replay([queued(4242, '2025-04-01')]);

      const warnMock = console.warn as unknown as jest.Mock;
      expect(warnMock).toHaveBeenCalledTimes(1);
      const logged = (warnMock.mock.calls[0] as unknown[]).map((arg) => String(arg)).join(' ');
      expect(logged).toContain('4242');
      expect(recordDroppedCheckIn).toHaveBeenCalledTimes(1);
      expect(recordDroppedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ goal_id: 4242, status: 422 }),
      );
    });

    it('preserves an explicit completed_on on the quarantined entry', async () => {
      const backdated = {
        goal_id: 55,
        did_complete: true,
        timestamp: '2025-04-05T00:00:00Z',
        completed_on: '2025-03-30',
      };
      (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
        new ApiError(409, 'conflict') as never,
      );

      await replay([backdated]);

      expect(recordDroppedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ goal_id: 55, status: 409, completed_on: '2025-03-30' }),
      );
    });

    // The quarantine is only real to the user once it reaches the store the
    // notice subscribes to, so every replay pass republishes it.
    describe('quarantine hydration', () => {
      const droppedEntry = (goalId: number) => ({
        goal_id: goalId,
        did_complete: true,
        timestamp: '2025-04-01T00:00:00Z',
        status: 404,
        dropped_at: '2025-04-02T09:00:00Z',
      });

      beforeEach(() => {
        (loadDroppedCheckIns as jest.Mock).mockReset();
        (loadDroppedCheckIns as jest.Mock).mockResolvedValue([] as never);
        droppedStore().getState().reset();
      });

      it('publishes a check-in dropped in an earlier session when the queue is now empty', async () => {
        (loadDroppedCheckIns as jest.Mock).mockResolvedValue([droppedEntry(77)] as never);

        await replay([]);

        const { entries } = droppedStore().getState();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.goal_id).toBe(77);
      });

      it('publishes a check-in dropped during this same replay pass', async () => {
        (loadDroppedCheckIns as jest.Mock).mockResolvedValue([droppedEntry(88)] as never);
        (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
          new ApiError(404, 'goal_not_found') as never,
        );

        await replay([queued(88, '2025-04-01')]);

        const { entries } = droppedStore().getState();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.goal_id).toBe(88);
      });

      it('retracts a stale notice by publishing an empty list when nothing is quarantined', async () => {
        droppedStore()
          .getState()
          .setEntries([droppedEntry(99)]);
        expect(droppedStore().getState().entries).toHaveLength(1);

        await replay([queued(12, '2025-04-01')]);

        expect(droppedStore().getState().entries).toHaveLength(0);
      });

      it('still refreshes the quarantine when a transient failure aborted the drain', async () => {
        (loadDroppedCheckIns as jest.Mock).mockResolvedValue([droppedEntry(64)] as never);
        (goalCompletionsApi.create as jest.Mock).mockRejectedValueOnce(
          new ApiError(503, 'unavailable') as never,
        );
        const pending = [queued(64, '2025-04-01')];

        await replay(pending);

        expect(replacePendingCheckIns).toHaveBeenCalledWith([pending[0]!]);
        const { entries } = droppedStore().getState();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.goal_id).toBe(64);
      });
    });

    it('re-queues only the transiently failed suffix when a drop came before it', async () => {
      const pending = [
        queued(61, '2025-04-01'),
        queued(62, '2025-04-02'),
        queued(63, '2025-04-03'),
      ];
      (goalCompletionsApi.create as jest.Mock)
        .mockRejectedValueOnce(new ApiError(404, 'goal_not_found') as never)
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(new ApiError(500, 'server_error') as never);

      await replay(pending);

      expect(clearPendingCheckIns).not.toHaveBeenCalled();
      expect(replacePendingCheckIns).toHaveBeenCalledWith([pending[2]!]);
    });
  });
});

describe('dismissDroppedCheckIns', () => {
  const quarantined = {
    goal_id: 31,
    did_complete: true,
    timestamp: '2025-04-01T00:00:00Z',
    status: 404,
    dropped_at: '2025-04-02T09:00:00Z',
  };

  beforeEach(() => {
    (clearDroppedCheckIns as jest.Mock).mockReset();
    (clearDroppedCheckIns as jest.Mock).mockResolvedValue(undefined as never);
    droppedStore().getState().reset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('erases the on-device quarantine and retracts the notice', async () => {
    droppedStore().getState().setEntries([quarantined]);

    await habitManager.dismissDroppedCheckIns();

    expect(clearDroppedCheckIns).toHaveBeenCalledTimes(1);
    expect(droppedStore().getState().entries).toHaveLength(0);
  });

  it('leaves the notice standing when the quarantine could not be erased', async () => {
    (clearDroppedCheckIns as jest.Mock).mockRejectedValueOnce(new Error('disk full') as never);
    droppedStore().getState().setEntries([quarantined]);

    await expect(habitManager.dismissDroppedCheckIns()).resolves.toBeUndefined();

    const { entries } = droppedStore().getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.goal_id).toBe(31);
  });
});
