/**
 * The one read of `GET /vault/connection` every surface shares (#3017).
 *
 * Where your corpus lives renders from it, and the three ways into "Bring in
 * your writing" -- the Settings row, the Journal band and drawer, and the
 * seeding screen itself -- gate on it, because a corpus lives in a vault
 * (#3015). One read, one reading of it: unknown until the server answers, and
 * unknown again when it cannot be reached, never "nothing attached".
 *
 * This module is the only caller of `vault.connection()` for reads under
 * `features/`, so the three-state reading cannot come to mean two things.
 */
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  CONNECTION_UNKNOWN,
  readConnectionState,
  type VaultConnectionState,
} from './vaultConnectionState';

import { vault } from '@/api';

/**
 * Ask the server what is attached, as one of the three states.
 *
 * Async so that a client that throws synchronously still becomes a rejection,
 * which is the one failure shape every caller handles.
 */
export async function readVaultConnection(): Promise<VaultConnectionState> {
  return readConnectionState(await vault.connection());
}

/**
 * The same read for a caller that only gates on it: never rejects, and a
 * failure resolves unknown -- which no gate reads as "no vault".
 */
export function fetchVaultConnectionState(): Promise<VaultConnectionState> {
  return readVaultConnection().catch(() => CONNECTION_UNKNOWN);
}

/** What the hook hands back: the state, a way to replace it, and whether it is read yet. */
export interface VaultConnectionRead {
  state: VaultConnectionState;
  setState: Dispatch<SetStateAction<VaultConnectionState>>;
  loading: boolean;
}

/**
 * Read the connection once, on mount.
 *
 * The route answers every account rather than 404ing one that has connected
 * nothing, so a failure here is a failure to reach the server -- reported to
 * `onError` as such, and never as "you have no vault". The state a failure
 * leaves behind says exactly that, and it is the state the read starts in:
 * before the answer arrives, nobody has checked either.
 *
 * `onError` is held in a ref so a caller that passes a fresh function each
 * render does not re-read; the failure goes to whichever handler is current
 * when it lands.
 */
export function useVaultConnectionState(onError?: () => void): VaultConnectionRead {
  const [state, setState] = useState<VaultConnectionState>(CONNECTION_UNKNOWN);
  const [loading, setLoading] = useState(true);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let live = true;
    void readVaultConnection()
      .then((answer) => {
        if (live) setState(answer);
      })
      .catch(() => {
        if (!live) return;
        setState(CONNECTION_UNKNOWN);
        onErrorRef.current?.();
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return { state, setState, loading };
}
