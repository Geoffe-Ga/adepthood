import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { AppState } from 'react-native';

import { refreshSessionToken } from '@/api';
import { getActiveUser } from '@/storage/userScope';
import { shouldRefreshToken } from '@/utils/token';

/** Auth refresh permits one rotation per minute. Retry on events, never a network timer. */
const RECOVERY_COOLDOWN_MS = 60_000;

interface RecoveryInputs {
  token: string | null;
  authStatus: string;
  ready: boolean;
  tokenRef: MutableRefObject<string | null>;
  applyNewToken: (_token: string, _timezone: string | undefined, _prior: string) => Promise<void>;
}

export function useTimezoneRecovery(inputs: RecoveryInputs): () => Promise<void> {
  const latest = useRef(inputs);
  latest.current = inputs;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const attempt = useRef({ token: inputs.token, at: Number.NEGATIVE_INFINITY, active: false });
  if (attempt.current.token !== inputs.token) {
    attempt.current = { token: inputs.token, at: Number.NEGATIVE_INFINITY, active: false };
  }
  const recover = useCallback(async (): Promise<void> => {
    const state = latest.current;
    const token = state.tokenRef.current;
    const slot = attempt.current;
    if (!token || !eligibleForRecovery(state, slot.active)) return;
    const now = Date.now();
    if (now - slot.at < RECOVERY_COOLDOWN_MS) return;
    const first = slot.at === Number.NEGATIVE_INFINITY;
    slot.at = now;
    // The proactive effect owns the initial request for an already-due token.
    // A failed attempt can still recover on the next event after the cooldown.
    if (first && shouldRefreshToken(token)) return;
    const owner = getActiveUser();
    slot.active = true;
    try {
      const response = await refreshSessionToken(token);
      if (!stillRecoverable(mounted.current, attempt.current === slot, owner, latest.current.ready))
        return;
      await latest.current.applyNewToken(response.token, response.timezone, token);
    } catch {
      // Offline recovery must leave the cached session and provisional queue intact.
    } finally {
      slot.active = false;
    }
  }, []);
  useEffect(() => {
    void recover();
    const listener = AppState.addEventListener('change', (status) => {
      if (status === 'active') void recover();
    });
    return () => listener.remove();
  }, [recover, inputs.token, inputs.authStatus, inputs.ready]);
  return recover;
}

function eligibleForRecovery(inputs: RecoveryInputs, active: boolean): boolean {
  return inputs.authStatus === 'authenticated' && !inputs.ready && !active;
}

function stillRecoverable(
  mounted: boolean,
  sameAttempt: boolean,
  owner: number | null,
  ready: boolean,
): boolean {
  return mounted && sameAttempt && getActiveUser() === owner && !ready;
}
