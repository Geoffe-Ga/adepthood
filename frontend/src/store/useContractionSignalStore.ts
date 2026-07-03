// In-memory signal for a currently-observed contraction. Not persisted: the
// signal is derived fresh from each journal resonance pass, so it lives only
// for the session and is wiped on logout via the shared store registry.
import { create } from 'zustand';

import { registerStoreReset } from './registry';

import type { ContractionReflection } from '@/api';

/**
 * Shared contraction-signal store. The journal resonance pass feeds it each
 * observed contraction; the Journal shelf reads ``active`` to decide whether the
 * declinable Return offer may surface. Latest pass wins, so a healthy or
 * simple-ease-off pass retracts a prior offer signal.
 */
export interface ContractionSignalState {
  // ``true`` only while the most recent observation was a ``return_offer``
  // contraction; ``false`` otherwise (initial, healthy, simple_ease_off).
  active: boolean;
  // Record the latest observed contraction (or its absence) and set ``active``
  // accordingly. Only a ``return_offer`` variant raises the signal.
  observe: (_contraction: ContractionReflection | null) => void;
  // Wipe back to the initial inactive state (logout / test reset).
  reset: () => void;
}

const INITIAL_STATE = {
  active: false,
};

export const useContractionSignalStore = create<ContractionSignalState>((set) => ({
  ...INITIAL_STATE,

  observe: (contraction) => {
    const active = contraction !== null && contraction.variant === 'return_offer';
    set({ active });
  },
  reset: () => {
    set({ ...INITIAL_STATE });
  },
}));

registerStoreReset(() => {
  useContractionSignalStore.getState().reset();
});
