import { useEffect } from 'react';

import { useToast } from '../../../components/ToastProvider';
import { useHabitStore } from '../../../store/useHabitStore';
import type { UseHabitsReturn } from '../Habits.types';
import { habitManager } from '../services/habitManager';

import { useHabitActions } from './useHabitActions';
import { registerForPushNotificationsAsync, reconcileNotifications } from './useHabitNotifications';
import { useHabitUI } from './useHabitUI';

const useBootstrapHabits = (): void => {
  useEffect(() => {
    void habitManager.loadHabits();
  }, []);
  useEffect(() => {
    void registerForPushNotificationsAsync();
    void reconcileNotifications();
  }, []);
};

/**
 * Composition-only hook. Reads habit data from the Zustand store, UI state
 * from `useHabitUI`, and delegates mutations to the `habitManager` service.
 *
 * This hook deliberately contains no business logic. All mutation behavior
 * lives in `services/habitManager.ts` and is independently unit-testable.
 */
export const useHabits = (): UseHabitsReturn => {
  const habits = useHabitStore((s) => s.habits);
  const loading = useHabitStore((s) => s.loading);
  const error = useHabitStore((s) => s.error);
  const storeSetHabits = useHabitStore((s) => s.setHabits);
  const { showToast } = useToast();
  const ui = useHabitUI();
  useBootstrapHabits();
  const actions = useHabitActions(ui, showToast);

  return {
    habits,
    loading,
    error,
    selectedHabit: ui.selectedHabit,
    setSelectedHabit: ui.setSelectedHabit,
    mode: ui.mode,
    setMode: ui.setMode,
    actions,
    ui: {
      showEnergyCTA: ui.showEnergyCTA,
      showArchiveMessage: ui.showArchiveMessage,
      archiveEnergyCTA: ui.archiveEnergyCTA,
      emojiHabitIndex: ui.emojiHabitIndex,
    },
    setHabitsForTesting: storeSetHabits,
  };
};
