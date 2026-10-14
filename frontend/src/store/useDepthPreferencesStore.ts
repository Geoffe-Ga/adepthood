import { create } from 'zustand';

import { depthPreferences } from '../api';
import type { DepthPreferences, DepthPreferencesUpdate } from '../api';

import { registerStoreReset } from './registry';

import { getActiveUser } from '@/storage/userScope';

/**
 * Depth-preferences store — the client-side mirror of the "you choose your
 * depth" ring toggles. Every ring is on by default, matching the product
 * principle that nothing is gated: a user opts *out* of a depth, never in.
 *
 * ``update`` waits for confirmation before publishing the submitted flags.
 * The backend changes each submitted ring independently; per-field request
 * ordering keeps an old full response from undoing another confirmed choice.
 * A failed call leaves the current flags untouched.
 */
export interface DepthPreferencesStoreState {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;

  /** Fetch the current ring toggles and replace local state with the result. */
  load: (_token?: string) => Promise<void>;
  /** Flip one or more rings; stores confirmed submitted flags on resolve. */
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

type Field = keyof DepthPreferences;
type Revisions = Partial<Record<Field, number>>;
const FIELDS = Object.keys(INITIAL_STATE) as Field[];
let generation = 0;
let requestSequence = 0;
let written: Revisions = {};
let confirmedWrites: Revisions = {};
let pendingWrites: Revisions = {};
let confirmedReads: Revisions = {};

function sessionGuard(): () => boolean {
  const owner = getActiveUser();
  const epoch = generation;
  return () => getActiveUser() === owner && generation === epoch;
}

/** A read cannot know a field while its write is unsettled, or undo a later write. */
function readResponse(): (_prefs: DepthPreferences) => DepthPreferencesUpdate {
  const current = sessionGuard();
  const sequence = ++requestSequence;
  const revisions = { ...written };
  const unsettled = { ...pendingWrites };
  return (prefs) => {
    if (!current()) return {};
    const result: DepthPreferencesUpdate = {};
    for (const field of FIELDS) {
      const unchanged = revisions[field] === written[field];
      const idle = !unsettled[field] && !pendingWrites[field];
      if (!unchanged || !idle || sequence < (confirmedReads[field] ?? 0)) continue;
      confirmedReads[field] = sequence;
      result[field] = prefs[field];
    }
    return result;
  };
}

/** The backend changes submitted fields independently; compare write confirmations per field. */
function writeResponse(partial: DepthPreferencesUpdate) {
  const current = sessionGuard();
  const sequence = ++requestSequence;
  const fields = Object.keys(partial) as Field[];
  for (const field of fields) {
    written[field] = sequence;
    pendingWrites[field] = (pendingWrites[field] ?? 0) + 1;
  }
  return {
    apply: (prefs: DepthPreferences): DepthPreferencesUpdate => {
      if (!current()) return {};
      const result: DepthPreferencesUpdate = {};
      for (const field of fields) {
        if (sequence < (confirmedWrites[field] ?? 0)) continue;
        confirmedWrites[field] = sequence;
        result[field] = prefs[field];
      }
      return result;
    },
    settle: () => {
      if (!current()) return;
      for (const field of fields) pendingWrites[field] = (pendingWrites[field] ?? 1) - 1;
    },
  };
}

export const useDepthPreferencesStore = create<DepthPreferencesStoreState>((set) => ({
  ...INITIAL_STATE,

  load: async (token) => {
    const confirmedFields = readResponse();
    try {
      const prefs = await depthPreferences.get(token);
      set(confirmedFields(prefs));
    } catch {
      // Leave the existing flags intact — a failed read must not flip a ring.
    }
  },

  update: async (partial, token) => {
    const response = writeResponse(partial);
    try {
      const prefs = await depthPreferences.update(partial, token);
      // Only this request's submitted fields are authoritative in its full echo.
      set(response.apply(prefs));
    } catch {
      // Leave the existing flags intact — a failed update must not flip a ring.
    } finally {
      response.settle();
    }
  },

  reset: () => {
    generation += 1;
    written = {};
    confirmedWrites = {};
    pendingWrites = {};
    confirmedReads = {};
    set({ ...INITIAL_STATE });
  },
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

/** Flip one or more rings; stores confirmed submitted flags on resolve. */
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
