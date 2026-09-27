/**
 * Load an existing journal entry by its route id, and load it again when the
 * device comes back online after that load failed (#2935).
 *
 * The first load runs once per route id. If it fails (most often because the
 * API client short-circuited the GET while the device was known offline), the
 * screen shows its load-error banner and keeps the entry-not-loaded gate on.
 * On the next offline -> online edge the load is re-run once, exactly as
 * ``useReconnectRetry`` re-runs a failed save on that edge (#2930): the effect
 * is keyed on connectivity alone and reads everything else through refs, so it
 * fires once per edge and never while merely online.
 */
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { shouldReloadEntryOnReconnect } from './journalReconnectLoad';

import { journal, type JournalMessage } from '@/api';
import { useNetworkStatus } from '@/context/NetworkStatusContext';

export interface EntryLoadInput {
  /** The entry to load, or null for a fresh page (never loaded). */
  routeEntryId: number | null;
  /** The stored entry has been applied to the page. */
  loaded: boolean;
  /** The last load attempt failed. */
  loadFailed: boolean;
  /** Apply a loaded entry to the page. Its identity must be stable. */
  apply: (_entry: JournalMessage) => void;
  /** Report a failed load. Its identity must be stable. */
  onError: () => void;
}

type FlagRef = MutableRefObject<boolean>;

/** Re-run the load once per offline -> online edge while the gate allows it. */
function useReloadOnReconnect(
  inputRef: MutableRefObject<EntryLoadInput>,
  inFlightRef: FlagRef,
  setLoadAttempt: Dispatch<SetStateAction<number>>,
): void {
  const { isOnline } = useNetworkStatus();
  const wasOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    const { routeEntryId, loaded, loadFailed } = inputRef.current;
    const gate = {
      wasOnline,
      isOnline,
      hasEntryId: routeEntryId != null,
      loaded,
      loadFailed,
      inFlight: inFlightRef.current,
    };
    if (!shouldReloadEntryOnReconnect(gate)) return;
    // Claim the slot now, so a second edge before the re-render cannot queue
    // another load behind this one.
    inFlightRef.current = true;
    setLoadAttempt((attempt) => attempt + 1);
  }, [isOnline, inputRef, inFlightRef, setLoadAttempt]);
}

/** Load the route entry, and reload it on reconnect after a failed load. */
export function useEntryLoad(input: EntryLoadInput): void {
  const { routeEntryId, apply, onError } = input;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const inFlightRef = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    if (routeEntryId == null) return undefined;
    let active = true;
    inFlightRef.current = true;
    void journal
      .get(routeEntryId)
      .then((entry) => {
        if (active) apply(entry);
      })
      .catch(() => {
        // A failed load flags the entry as unloaded so autosave is gated off and
        // the screen surfaces a banner; the untouched entry is never overwritten.
        if (active) onError();
      })
      .finally(() => {
        if (active) inFlightRef.current = false;
      });
    return () => {
      active = false;
      inFlightRef.current = false;
    };
  }, [routeEntryId, loadAttempt, apply, onError]);

  useReloadOnReconnect(inputRef, inFlightRef, setLoadAttempt);
}
