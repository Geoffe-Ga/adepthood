// First-run state for the program welcome (issue #836). The SERVER owns the
// per-account ``has_seen_welcome`` flag after login; AsyncStorage is only an
// offline/latency cache. On mount we hydrate from ``GET /ui-flags`` and re-seed
// the local cache to match, falling back to the cache when the server is
// unreachable. This keeps the intro per-account instead of per-device.
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { uiFlags } from '../api';
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
  // Mark the welcome complete (Begin or Skip); persists local + syncs server.
  markWelcomeSeen: (_token?: string) => void;
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

// Server is source of truth after login; fall back to the local cache only when
// the GET rejects (offline / 401). Kept flat to stay well under the cognitive
// complexity budget.
async function resolveHasSeenWelcome(token?: string): Promise<boolean> {
  try {
    const flags = await uiFlags.get(token);
    return flags.has_seen_welcome;
  } catch {
    return loadHasSeenWelcome();
  }
}

export const useWelcomeStore = create<WelcomeStoreState>((set) => ({
  ...INITIAL_STATE,

  hydrateHasSeenWelcome: (seen) => {
    set({ hasSeenWelcome: seen });
  },
  markWelcomeSeen: (token) => {
    set({ hasSeenWelcome: true });
    persistAsync(true);
    uiFlags.update({ has_seen_welcome: true }, token).catch((err) => {
      console.warn('[useWelcomeStore] failed to sync welcome flag', err);
    });
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
 * First-run gate for the program welcome. On mount it hydrates the flag from the
 * server (``GET /ui-flags``, source of truth after login), re-seeding the local
 * cache both directions, and falls back to that cache when the server is
 * unreachable. ``isFirstRun`` is ``true`` exactly when the flag resolves to
 * unset; it flips to ``false`` the moment ``markSeen`` runs, so the welcome
 * shows once per account and never again.
 */
export function useFirstRun(token?: string | null): FirstRun {
  const normalizedToken = token ?? undefined;
  const hasSeenWelcome = useWelcomeStore((s) => s.hasSeenWelcome);
  const hydrate = useWelcomeStore((s) => s.hydrateHasSeenWelcome);
  const markWelcomeSeen = useWelcomeStore((s) => s.markWelcomeSeen);

  useEffect(() => {
    if (hasSeenWelcome !== null) return;
    let cancelled = false;
    void resolveHasSeenWelcome(normalizedToken).then((seen) => {
      if (cancelled) return;
      hydrate(seen);
      persistAsync(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSeenWelcome, hydrate, normalizedToken]);

  const markSeen = useCallback(() => {
    markWelcomeSeen(normalizedToken);
  }, [markWelcomeSeen, normalizedToken]);

  return {
    isFirstRun: hasSeenWelcome === false,
    hydrated: hasSeenWelcome !== null,
    markSeen,
  };
}
