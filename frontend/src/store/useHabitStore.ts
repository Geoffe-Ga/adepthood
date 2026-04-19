import { create } from 'zustand';

import type { Habit } from '../features/Habits/Habits.types';

import { registerStoreReset } from './registry';

/**
 * Habit store — a dumb state container. No API calls live here; those belong
 * in `features/Habits/services/habitManager.ts`.
 *
 * Canonical shape is `habitsById` + `habitOrder` for O(1) lookups; the `habits`
 * array is a derived cache maintained by the mutation actions so consumers can
 * iterate without rebuilding it on every render. Use the `selectHabitById`
 * selector for single-item subscriptions to avoid re-renders on unrelated
 * mutations.
 */
export interface HabitStoreState {
  /** ID-keyed map — the canonical source of truth for per-habit lookups. */
  habitsById: Record<number, Habit>;
  /** Insertion order, preserved across mutations. */
  habitOrder: number[];
  /** Derived array view of habits in `habitOrder`. Kept in sync by actions. */
  habits: Habit[];
  loading: boolean;
  error: string | null;

  setHabits: (_habits: Habit[]) => void;
  setLoading: (_loading: boolean) => void;
  setError: (_error: string | null) => void;
  updateHabit: (_habit: Habit) => void;
  removeHabit: (_habitId: number) => void;
  /** BUG-FE-STATE-001: wipe every field back to its initial value on logout. */
  reset: () => void;
}

const INITIAL_STATE = {
  habitsById: {} as Record<number, Habit>,
  habitOrder: [] as number[],
  habits: [] as Habit[],
  loading: false,
  error: null as string | null,
};

interface NormalizedHabits {
  habitsById: Record<number, Habit>;
  habitOrder: number[];
  habits: Habit[];
}

const normalizeHabits = (habits: Habit[]): NormalizedHabits => {
  const habitsById: Record<number, Habit> = {};
  const habitOrder: number[] = [];
  for (const habit of habits) {
    habitsById[habit.id] = habit;
    habitOrder.push(habit.id);
  }
  return { habitsById, habitOrder, habits: [...habits] };
};

const rebuildHabitsList = (habitsById: Record<number, Habit>, habitOrder: number[]): Habit[] =>
  habitOrder.map((id) => habitsById[id]!).filter((h): h is Habit => h !== undefined);

export const useHabitStore = create<HabitStoreState>((set) => ({
  ...INITIAL_STATE,

  setHabits: (habits) => set(normalizeHabits(habits)),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  updateHabit: (updatedHabit) =>
    set((state) => {
      if (!(updatedHabit.id in state.habitsById)) return state;
      const habitsById = { ...state.habitsById, [updatedHabit.id]: updatedHabit };
      return { habitsById, habits: rebuildHabitsList(habitsById, state.habitOrder) };
    }),
  removeHabit: (habitId) =>
    set((state) => {
      if (!(habitId in state.habitsById)) return state;
      const habitsById = { ...state.habitsById };
      delete habitsById[habitId];
      const habitOrder = state.habitOrder.filter((id) => id !== habitId);
      return { habitsById, habitOrder, habits: rebuildHabitsList(habitsById, habitOrder) };
    }),
  reset: () => set({ ...INITIAL_STATE }),
}));

// BUG-FE-STATE-001: publish our reset to the shared registry so a single
// ``resetAllStores()`` call in AuthContext.logout clears every store.
registerStoreReset(() => {
  useHabitStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Selectors — narrow state subscriptions. Zustand compares the *value*
// returned by a selector with `Object.is`, so components re-render only when
// their specific slice changes. Prefer these over destructuring the whole
// store (which re-renders on every unrelated mutation).
// ---------------------------------------------------------------------------

export const selectHabits = (state: HabitStoreState): Habit[] => state.habits;
export const selectHabitsLoading = (state: HabitStoreState): boolean => state.loading;
export const selectHabitsError = (state: HabitStoreState): string | null => state.error;

/**
 * Factory for a "single habit by ID" selector. The habit lookup is O(1) via
 * the canonical `habitsById` map, and Zustand will only trigger a re-render
 * when that specific habit's reference changes.
 */
export const selectHabitById =
  (id: number | null | undefined) =>
  (state: HabitStoreState): Habit | undefined =>
    id == null ? undefined : state.habitsById[id];
