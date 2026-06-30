// First-run state for the program welcome (issue #836). Backed by AsyncStorage
// so the editorial intro shows exactly once; returning users are never gated.
import { useEffect } from 'react';
import { create } from 'zustand';

import {
  clearHasSeenWelcome,
  loadHasSeenWelcome,
  saveHasSeenWelcome,
} from '../storage/welcomeStorage';

import { registerStoreReset } from './registry';

export interface WelcomeStoreState {
  // ``null`` while the persisted flag has not yet been read from storage; the
  // welcome gate stays closed until hydration resolves so returning users never
  // see a flash of the intro on cold start.
  hasSeenWelcome: boolean | null;
  // Seed from storage on boot without re-writing it.
  hydrateHasSeenWelcome: (_seen: boolean) => void;
  // Mark the welcome complete (Begin or Skip) and persist it.
  markWelcomeSeen: () => void;
  // BUG-FE-STATE-001: wipe on logout. Also clears persisted storage.
  reset: () => void;
}

const INITIAL_STATE = {
  hasSeenWelcome: null as boolean | null,
};

const persistAsync = (seen: boolean): void => {
  const op = seen ? saveHasSeenWelcome() : clearHasSeenWelcome();
  op.catch((err) => {
    console.warn('[useWelcomeStore] failed to persist welcome flag', err);
  });
};

export const useWelcomeStore = create<WelcomeStoreState>((set) => ({
  ...INITIAL_STATE,

  hydrateHasSeenWelcome: (seen) => {
    set({ hasSeenWelcome: seen });
  },
  markWelcomeSeen: () => {
    set({ hasSeenWelcome: true });
    persistAsync(true);
  },
  reset: () => {
    set({ ...INITIAL_STATE });
    persistAsync(false);
  },
}));

registerStoreReset(() => {
  useWelcomeStore.getState().reset();
});

export interface FirstRun {
  // ``true`` only once storage has resolved and the flag is unset; ``false``
  // before hydration and for returning users.
  isFirstRun: boolean;
  // ``true`` once the persisted flag has been read (regardless of its value).
  hydrated: boolean;
  // Persist the flag and close the welcome gate (Begin or Skip).
  markSeen: () => void;
}

/**
 * First-run gate for the program welcome. Hydrates the persisted flag on mount,
 * then reports whether the editorial intro should show. ``isFirstRun`` is
 * ``true`` exactly when the flag has resolved to unset; it flips to ``false``
 * the moment ``markSeen`` runs, so the welcome shows once and never again.
 */
export function useFirstRun(): FirstRun {
  const hasSeenWelcome = useWelcomeStore((s) => s.hasSeenWelcome);
  const hydrate = useWelcomeStore((s) => s.hydrateHasSeenWelcome);
  const markSeen = useWelcomeStore((s) => s.markWelcomeSeen);

  useEffect(() => {
    if (hasSeenWelcome !== null) return;
    let cancelled = false;
    void loadHasSeenWelcome().then((seen) => {
      if (!cancelled) hydrate(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSeenWelcome, hydrate]);

  return {
    isFirstRun: hasSeenWelcome === false,
    hydrated: hasSeenWelcome !== null,
    markSeen,
  };
}
