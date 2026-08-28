// In-memory mirror of the on-device dropped-check-in quarantine. Not the
// source of truth: `habitManager` owns the storage reads and writes (the same
// division `useHabitStore` documents) and republishes the quarantine here on
// every replay pass, including the empty case that retracts a stale notice.
import { create } from 'zustand';

import { registerStoreReset } from './registry';

import type { DroppedCheckIn } from '@/storage/habitStorage';

/**
 * Shared dropped-check-in store, read by the Habits notice.
 *
 * Deliberately NOT ``useHabitStore.error``: that field renders a Retry
 * affordance, and retrying is exactly what cannot recover a permanently
 * rejected check-in; worse, ``loadHabits`` calls ``setError(null)`` on every
 * pass, so the report of the loss would be wiped by the next refresh. This
 * store is cleared only when the user dismisses the notice or logs out.
 */
export interface DroppedCheckInState {
  // The quarantine as of the most recent replay pass. Latest pass wins.
  entries: DroppedCheckIn[];
  // Replace the published quarantine. An empty list is meaningful: it
  // retracts a notice whose entries have since been cleared.
  setEntries: (_entries: DroppedCheckIn[]) => void;
  // Wipe back to the initial empty state (logout / test reset).
  reset: () => void;
}

const INITIAL_STATE = {
  entries: [] as DroppedCheckIn[],
};

export const useDroppedCheckInStore = create<DroppedCheckInState>((set) => ({
  ...INITIAL_STATE,

  setEntries: (entries) => {
    set({ entries });
  },
  reset: () => {
    set({ ...INITIAL_STATE });
  },
}));

registerStoreReset(() => {
  useDroppedCheckInStore.getState().reset();
});
