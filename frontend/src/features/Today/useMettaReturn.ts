/**
 * ``useMettaReturn`` — loads the Return surface on mount and drives its
 * lifecycle without ever nagging.
 *
 * Silent by default: a failed load leaves everything empty rather than crashing
 * the tab, and the offer only becomes visible when the person is eligible, a
 * contraction is currently observed, they have not already set the offer aside,
 * and no arc is running. ``dismissOffer`` hides the offer and persists the
 * decline; ``start``/``pause``/``resume``/``leave`` update the local arc
 * optimistically and revert on error. An unmount guard keeps late resolutions
 * from setting state on a dead hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { isContractionSignalActive } from './contractionSignal';

import { mettaReturn } from '@/api';
import type { ReturnArc, ReturnWeek } from '@/api';
import { loadReturnOfferDismissed, saveReturnOfferDismissed } from '@/storage/returnOfferStorage';

export interface UseMettaReturnResult {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offerVisible: boolean;
  dismissOffer: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  leave: () => Promise<void>;
}

interface LoadedReturn {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  dismissed: boolean;
  setArc: (_arc: ReturnArc | null) => void;
  setDismissed: (_dismissed: boolean) => void;
  mountedRef: MutableRefObject<boolean>;
}

/** Persist the dismissal flag best-effort — a failed write leaves the server authoritative. */
function cacheDismissed(value: boolean): void {
  void saveReturnOfferDismissed(value).catch(() => {
    // A failed cache write is harmless — the server flag remains the source of truth.
  });
}

/** Own the Return state and load it (server state + persisted decline) once on mount. */
function useLoadedReturn(): LoadedReturn {
  const [eligible, setEligible] = useState(false);
  const [weeks, setWeeks] = useState<ReturnWeek[]>([]);
  const [arc, setArc] = useState<ReturnArc | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);
  const serverAppliedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    serverAppliedRef.current = false;
    void loadReturnOfferDismissed()
      .then((wasDismissed) => {
        // Cache seeds the flag only until the server answers — server wins.
        if (mountedRef.current && !serverAppliedRef.current) setDismissed(wasDismissed);
      })
      .catch(() => {
        // A failed flag read stays silent — the offer simply is not suppressed.
      });
    void mettaReturn
      .state()
      .then((state) => {
        if (!mountedRef.current) return;
        serverAppliedRef.current = true;
        setEligible(state.eligible);
        setWeeks(state.weeks);
        setArc(state.arc);
        setDismissed(state.offer_dismissed);
        cacheDismissed(state.offer_dismissed);
      })
      .catch(() => {
        // A failed load stays silent — the Return must never nag or crash the tab.
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { eligible, weeks, arc, dismissed, setArc, setDismissed, mountedRef };
}

export function useMettaReturn(): UseMettaReturnResult {
  const { eligible, weeks, arc, dismissed, setArc, setDismissed, mountedRef } = useLoadedReturn();
  const arcRef = useRef<ReturnArc | null>(null);

  // Mirror the committed arc into a ref so a lifecycle call can snapshot it
  // synchronously for the revert branch when the API rejects immediately.
  useEffect(() => {
    arcRef.current = arc;
  }, [arc]);

  const dismissOffer = useCallback(async (): Promise<void> => {
    setDismissed(true);
    cacheDismissed(true);
    try {
      await mettaReturn.dismissOffer();
    } catch {
      // A failed dismiss stays silent — the offer must never re-show once declined.
    }
  }, [setDismissed]);

  const start = useCallback(async (): Promise<void> => {
    const started = await mettaReturn.start();
    if (mountedRef.current) setArc(started);
  }, [mountedRef, setArc]);

  const runLifecycle = useCallback(
    async (call: () => Promise<ReturnArc>): Promise<void> => {
      const snapshot = arcRef.current;
      try {
        const updated = await call();
        if (mountedRef.current) setArc(updated);
      } catch (err) {
        if (mountedRef.current) setArc(snapshot);
        throw err;
      }
    },
    [mountedRef, setArc],
  );

  const pause = useCallback(() => runLifecycle(() => mettaReturn.pause()), [runLifecycle]);
  const resume = useCallback(() => runLifecycle(() => mettaReturn.resume()), [runLifecycle]);

  const leave = useCallback(async (): Promise<void> => {
    await mettaReturn.leave();
    if (mountedRef.current) setArc(null);
  }, [mountedRef, setArc]);

  const offerVisible = eligible && isContractionSignalActive() && !dismissed && arc === null;

  return { eligible, weeks, arc, offerVisible, dismissOffer, start, pause, resume, leave };
}
