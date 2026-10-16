import { useCallback, useEffect, useRef, useState } from 'react';

import { habitSyncScopeKey } from '../services/habitSyncScope';

import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';
import { useHabitStore, type HabitServerSync } from '@/store/useHabitStore';

export interface EnergyOnboardingParams {
  onboardingIntent?: 'energy-scaffolding';
  onboardingOwner?: number;
  onboardingGeneration?: number;
}

/**
 * Where a consumed Course handoff stands. `waiting`: the account's habits have
 * not been read from the server yet, so the review would ask a returning user
 * about nothing. `failed`: the last read for this session failed and the
 * handoff opens once a retry succeeds. `idle`: nothing is held.
 */
export type EnergyHandoffStatus = 'idle' | 'waiting' | 'failed';

export interface EnergyHandoff {
  status: EnergyHandoffStatus;
  /** Decline the held handoff: a later read then opens nothing. */
  cancel: () => void;
}

interface PendingHandoff {
  owner: number;
  generation: number;
}

/** The account, its generation and the Habits ring that the request was made under all still hold. */
const stillValid = ({ owner, generation }: PendingHandoff, ringEnabled: boolean): boolean =>
  ringEnabled && owner === getActiveUser() && generation === getActiveUserGeneration();

const syncFor = (sync: HabitServerSync | null): HabitServerSync['status'] | null =>
  sync?.scope === habitSyncScopeKey() ? sync.status : null;

/**
 * Consume the route request at once, so a warm tab cannot replay a closed
 * modal, but open only after this account's habits have been read from the
 * server under the live session (#3328). Opening on the cold tab's first
 * render showed a returning user the empty new-user flow: the modal seeds its
 * review once, on entry, from whatever rows the store held at that moment.
 */
export function useEnergyOnboardingIntent(
  params: EnergyOnboardingParams | undefined,
  clear: (() => void) | undefined,
  open: () => void,
): EnergyHandoff {
  const consumed = useRef(false);
  const [pending, setPending] = useState<PendingHandoff | null>(null);
  const serverSync = useHabitStore((s) => s.serverSync);
  const ringEnabled = useDepthPreferencesStore((s) => s.enable_habits);
  const intent = params?.onboardingIntent;
  const owner = params?.onboardingOwner;
  const generation = params?.onboardingGeneration;
  useEffect(() => {
    if (!intent) {
      consumed.current = false;
      return;
    }
    if (!clear || consumed.current) return;
    consumed.current = true;
    clear();
    if (owner === undefined || generation === undefined) return;
    const request = { owner, generation };
    if (stillValid(request, useDepthPreferencesStore.getState().enable_habits)) setPending(request);
  }, [intent, owner, generation, clear]);
  useEffect(() => {
    if (!pending) return;
    if (!stillValid(pending, ringEnabled)) {
      setPending(null);
      return;
    }
    if (syncFor(serverSync) !== 'ok') return;
    setPending(null);
    open();
  }, [pending, serverSync, ringEnabled, open]);
  const cancel = useCallback(() => setPending(null), []);
  if (!pending || !stillValid(pending, ringEnabled)) return { status: 'idle', cancel };
  return { status: syncFor(serverSync) === 'failed' ? 'failed' : 'waiting', cancel };
}
