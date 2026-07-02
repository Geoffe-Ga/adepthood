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

import { useContractionSignalActive } from './contractionSignal';

import { mettaReturn } from '@/api';
import type { ReturnArc, ReturnWeek } from '@/api';
import { loadReturnOfferDismissed, saveReturnOfferDismissed } from '@/storage/returnOfferStorage';

export interface UseMettaReturnResult {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offerVisible: boolean;
  dismissOffer: () => void;
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

/** Own the Return state and load it (server state + persisted decline) once on mount. */
function useLoadedReturn(): LoadedReturn {
  const [eligible, setEligible] = useState(false);
  const [weeks, setWeeks] = useState<ReturnWeek[]>([]);
  const [arc, setArc] = useState<ReturnArc | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void loadReturnOfferDismissed()
      .then((wasDismissed) => {
        if (mountedRef.current) setDismissed(wasDismissed);
      })
      .catch(() => {
        // A failed flag read stays silent — the offer simply is not suppressed.
      });
    void mettaReturn
      .state()
      .then((state) => {
        if (!mountedRef.current) return;
        setEligible(state.eligible);
        setWeeks(state.weeks);
        setArc(state.arc);
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
  const contractionActive = useContractionSignalActive();
  const arcRef = useRef<ReturnArc | null>(null);

  // Mirror the committed arc into a ref so a lifecycle call can snapshot it
  // synchronously for the revert branch when the API rejects immediately.
  useEffect(() => {
    arcRef.current = arc;
  }, [arc]);

  const dismissOffer = useCallback((): void => {
    setDismissed(true);
    void saveReturnOfferDismissed().catch(() => {
      // A failed persist is harmless — the offer is already hidden this session.
    });
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

  const offerVisible = eligible && contractionActive && !dismissed && arc === null;

  return { eligible, weeks, arc, offerVisible, dismissOffer, start, pause, resume, leave };
}
