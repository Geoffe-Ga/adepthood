import { create } from 'zustand';

import type { Habit } from '../features/Habits/Habits.types';

export interface HabitStoreState {
  habits: Habit[];
  loading: boolean;
  error: string | null;

  setHabits: (_habits: Habit[]) => void;
  setLoading: (_loading: boolean) => void;
  setError: (_error: string | null) => void;
  updateHabit: (_habit: Habit) => void;
  removeHabit: (_habitId: number) => void;
}

export const useHabitStore = create<HabitStoreState>((set) => ({
  habits: [],
  loading: false,
  error: null,

  setHabits: (habits) => set({ habits }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  updateHabit: (updatedHabit) =>
    set((state) => ({
      habits: state.habits.map((h) => (h.id === updatedHabit.id ? updatedHabit : h)),
    })),
  removeHabit: (habitId) =>
    set((state) => ({
      habits: state.habits.filter((h) => h.id !== habitId),
    })),
}));
