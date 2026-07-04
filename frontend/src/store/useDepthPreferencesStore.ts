import { create } from 'zustand';

import { depthPreferences } from '../api';
import type { DepthPreferences, DepthPreferencesUpdate } from '../api';

import { registerStoreReset } from './registry';

/**
 * Depth-preferences store — the client-side mirror of the "you choose your
 * depth" ring toggles. Every ring is on by default, matching the product
 * principle that nothing is gated: a user opts *out* of a depth, never in.
 *
 * Unlike an optimistic toggle, ``update`` waits for the server's echoed full
 * state before mutating: the four flags interact (a backend rule may force a
 * dependent ring off), so the authoritative post-update snapshot is the only
 * safe thing to store. A failed call leaves the current flags untouched.
 */
export interface DepthPreferencesStoreState {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;

  /** Fetch the current ring toggles and replace local state with the result. */
  load: (_token?: string) => Promise<void>;
  /** Flip one or more rings; stores the server's echoed full state on resolve. */
  update: (_partial: DepthPreferencesUpdate, _token?: string) => Promise<void>;
  /** Wipe every field back to the all-on defaults on logout. */
  reset: () => void;
}

const INITIAL_STATE = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

/** Narrow the four toggle flags out of a full API response. */
const toToggles = (prefs: DepthPreferences) => ({
  enable_habits: prefs.enable_habits,
  enable_practices: prefs.enable_practices,
  enable_course: prefs.enable_course,
  enable_sangha: prefs.enable_sangha,
});

export const useDepthPreferencesStore = create<DepthPreferencesStoreState>((set) => ({
  ...INITIAL_STATE,

  load: async (token) => {
    try {
      const prefs = await depthPreferences.get(token);
      set({ ...toToggles(prefs) });
    } catch {
      // Leave the existing flags intact — a failed read must not flip a ring.
    }
  },

  update: async (partial, token) => {
    try {
      const prefs = await depthPreferences.update(partial, token);
      // Non-optimistic: state comes only from the server's echoed full snapshot.
      set({ ...toToggles(prefs) });
    } catch {
      // Leave the existing flags intact — a failed update must not flip a ring.
    }
  },

  reset: () => set({ ...INITIAL_STATE }),
}));

// Publish our reset to the shared registry so a single ``resetAllStores()``
// call in AuthContext.logout clears every store, including this one.
registerStoreReset(() => {
  useDepthPreferencesStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Stable action exports — module-level bound references to the store actions so
// a consumer can call them without subscribing (they never change identity,
// making them safe dependency-free deps in a mount-only effect).
// ---------------------------------------------------------------------------

/** Fetch the current ring toggles and replace local state with the result. */
export const load = (token?: string): Promise<void> =>
  useDepthPreferencesStore.getState().load(token);

/** Flip one or more rings; stores the server's echoed full state on resolve. */
export const update = (partial: DepthPreferencesUpdate, token?: string): Promise<void> =>
  useDepthPreferencesStore.getState().update(partial, token);

// ---------------------------------------------------------------------------
// Selectors — narrow state subscriptions. Zustand compares the returned value
// with ``Object.is``, so components re-render only when their slice changes.
// ---------------------------------------------------------------------------

export const selectEnableHabits = (state: DepthPreferencesStoreState): boolean =>
  state.enable_habits;
export const selectEnablePractices = (state: DepthPreferencesStoreState): boolean =>
  state.enable_practices;
export const selectEnableCourse = (state: DepthPreferencesStoreState): boolean =>
  state.enable_course;
export const selectEnableSangha = (state: DepthPreferencesStoreState): boolean =>
  state.enable_sangha;
