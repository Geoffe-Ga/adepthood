import { useEffect, useRef } from 'react';

import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

export interface EnergyOnboardingParams {
  onboardingIntent?: 'energy-scaffolding';
  onboardingOwner?: number;
  onboardingGeneration?: number;
}

/** Consume the route request before opening: warm tabs must not replay a closed modal. */
export function useEnergyOnboardingIntent(
  params: EnergyOnboardingParams | undefined,
  clear: (() => void) | undefined,
  open: () => void,
): void {
  const consumed = useRef(false);
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
    if (
      owner === getActiveUser() &&
      owner !== undefined &&
      generation === getActiveUserGeneration() &&
      useDepthPreferencesStore.getState().enable_habits
    )
      open();
  }, [intent, owner, generation, clear, open]);
}
