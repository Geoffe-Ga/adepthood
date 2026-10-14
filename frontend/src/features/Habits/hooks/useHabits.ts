import { useCallback, useEffect } from 'react';

import { useToast } from '../../../components/ToastProvider';
import { useAuth } from '../../../context/AuthContext';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { useHabitStore } from '../../../store/useHabitStore';
import type { UseHabitsReturn } from '../Habits.types';
import { habitManager } from '../services/habitManager';

import { useHabitActions } from './useHabitActions';
import { registerForPushNotificationsAsync, reconcileNotifications } from './useHabitNotifications';
import { useHabitUI } from './useHabitUI';

export const useBootstrapHabits = (userTimezone: string, userTimezoneReady = true): void => {
  // Cached habits remain readable before auth hydrates the account calendar,
  // but a provisional fallback must not assign durable replay days (#269).
  const reload = useCallback(() => {
    if (userTimezoneReady) void habitManager.loadHabits(userTimezone);
    else void habitManager.loadHabits(userTimezone, { replayCheckIns: false });
  }, [userTimezone, userTimezoneReady]);
  useEffect(() => {
    reload();
  }, [reload]);
  // The tab stays mounted once visited, so the effect above is the only read
  // the screen would ever do: a check-in accepted from the journal, or a day
  // that turned over elsewhere, stayed invisible until a restart (#2764).
  // Returning to the tab is one way back in; foregrounding the app on the tab
  // the user never left is the other, and only the first was covered (#2847).
  useRefetchOnReturn(reload);
  useEffect(() => {
    // Abort on unmount so in-flight notification work cannot mutate stale state.
    const controller = new AbortController();
    void registerForPushNotificationsAsync(controller.signal);
    void reconcileNotifications(controller.signal);
    return () => {
      controller.abort();
    };
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
  const { userTimezone, userTimezoneReady, token } = useAuth();
  const ui = useHabitUI(token);
  useBootstrapHabits(userTimezone, userTimezoneReady);
  const actions = useHabitActions(ui, showToast, userTimezone);

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
    },
    setHabitsForTesting: storeSetHabits,
  };
};
