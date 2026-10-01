/**
 * A store for "which habit does a finished session check off?" — one per
 * kind of session. ``useWritingHabitLinkStore`` (the writing timer, #2861) and
 * ``usePracticeHabitLinkStore`` (practice sessions) are two instances of this
 * factory, each mirroring its own nullable field on ``/ui-flags``.
 *
 * The SERVER owns every link, so a fresh device honours a choice made on
 * another one. A store is only the in-memory mirror, hydrated from
 * ``GET /ui-flags`` on mount the way ``useWelcomeStore`` is, and written
 * through ``PATCH /ui-flags``.
 *
 * Three rules keep it honest:
 *
 * - **A failed read is not an answer.** ``hydrated`` turns true only when the
 *   server replied, so one flaky request cannot switch the check-off off for the
 *   rest of the session: the next mount asks again. Until then ``habitId`` is
 *   ``null``, which means "check nothing off" — the quiet default.
 * - **The server's echo is the truth.** ``setLink`` adopts the id the PATCH
 *   returned, never the one it sent, and a refused PATCH changes nothing.
 * - **An answer belongs to the account that asked.** Every ``reset`` (logout)
 *   bumps a generation; a read started before it is dropped when it lands, so
 *   one account's link can never surface under the next.
 *
 * The instances are independent on purpose: each has its own in-flight read
 * and its own generation, and forgetting a deleted habit on one says nothing
 * about the other — ``habitManager``'s delete path tells each store itself.
 */
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

import { uiFlags } from '../api';
import type { UiFlags, UiFlagsUpdate } from '../api';

import { registerStoreReset } from './registry';

/** The ``/ui-flags`` fields a session link can live on. */
export type HabitLinkField = 'writing_session_habit_id' | 'practice_session_habit_id';

export interface HabitLinkState {
  /** The linked habit's id, or ``null`` when none is linked (or not yet known). */
  habitId: number | null;
  /** Whether ``habitId`` came from the server, rather than being the default. */
  hydrated: boolean;
  /** Read the link from the server once; a no-op when already hydrated. */
  hydrate: (_token?: string) => Promise<void>;
  /** Link a habit (or clear with ``null``); resolves whether the server agreed. */
  setLink: (_habitId: number | null, _token?: string) => Promise<boolean>;
  /**
   * The linked habit was deleted on this device: forget it locally. The server
   * has already cleared its own copy (``delete_habit`` unlinks it).
   */
  forgetHabit: (_habitId: number) => void;
  /** Forget the link (logout). */
  reset: () => void;
}

export type HabitLinkStore = UseBoundStore<StoreApi<HabitLinkState>>;

const INITIAL_STATE = { habitId: null as number | null, hydrated: false };

/** The field as the server sent it; a server that predates it reads as unlinked. */
const linkFrom = (flags: UiFlags, field: HabitLinkField): number | null => flags[field] ?? null;

/**
 * Build a link store over one ``/ui-flags`` field. ``logTag`` names the store
 * in its warnings, so a failed read says which link it was.
 */
export function createHabitLinkStore(field: HabitLinkField, logTag: string): HabitLinkStore {
  /** The hydrate already on the wire, so concurrent mounts share one request. */
  let inFlight: Promise<void> | null = null;

  /** Bumped by every ``reset``; a read that began under an older one is stale. */
  let generation = 0;

  const store = create<HabitLinkState>((set, get) => ({
    ...INITIAL_STATE,

    hydrate: (token) => {
      if (get().hydrated) return Promise.resolve();
      if (inFlight) return inFlight;
      // Started inside a ``then`` so even a synchronous throw from the client
      // lands in the ``catch`` below: a hydrate must never break the page that
      // asked for it.
      const startedIn = generation;
      const request = Promise.resolve()
        .then(() => uiFlags.get(token))
        .then((flags) => {
          if (startedIn !== generation) return;
          set({ habitId: linkFrom(flags, field), hydrated: true });
        })
        .catch((err: unknown) => {
          console.warn(`[${logTag}] failed to read the habit link`, err);
        })
        .finally(() => {
          if (inFlight === request) inFlight = null;
        });
      inFlight = request;
      return request;
    },

    setLink: async (habitId, token) => {
      const body: UiFlagsUpdate = {};
      body[field] = habitId;
      try {
        const flags = await uiFlags.update(body, token);
        set({ habitId: linkFrom(flags, field), hydrated: true });
        return true;
      } catch (err) {
        console.warn(`[${logTag}] failed to save the habit link`, err);
        return false;
      }
    },

    forgetHabit: (habitId) => {
      if (get().habitId === habitId) set({ habitId: null });
    },

    reset: () => {
      generation += 1;
      inFlight = null;
      set({ ...INITIAL_STATE });
    },
  }));

  registerStoreReset(() => {
    store.getState().reset();
  });

  return store;
}
