/**
 * ``useMettaReturn`` — loads the Return surface on mount and drives its
 * lifecycle without ever nagging.
 *
 * Silent by default: a failed load leaves everything empty rather than crashing
 * the tab, and the offer only becomes visible when the person is eligible, a
 * contraction is currently observed, they have not already set the offer aside,
 * and no arc is running. ``dismissOffer`` hides the offer and persists the
 * decline; ``start``/``pause``/``resume``/``leave`` commit the local arc only
 * after the API confirms — a rejected call propagates the error and leaves the
 * arc unchanged. An unmount guard keeps late resolutions from setting state on a
 * dead hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { useContractionSignalActive } from './contractionSignal';

import { mettaReturn } from '@/api';
import type { ReleasedHabit, ReturnArc, ReturnWeek } from '@/api';
import { loadReturnOfferDismissed, saveReturnOfferDismissed } from '@/storage/returnOfferStorage';

export interface UseMettaReturnResult {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offerVisible: boolean;
  letGoVisible: boolean;
  releasedHabits: ReleasedHabit[];
  dismissOffer: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  leave: () => Promise<void>;
  release: (_habitIds: number[]) => Promise<void>;
  recommit: (_habitIds: number[]) => Promise<void>;
  skipLetGo: () => void;
}

interface LoadedReturn {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  dismissed: boolean;
  releasedHabits: ReleasedHabit[];
  setArc: (_arc: ReturnArc | null) => void;
  setDismissed: (_dismissed: boolean) => void;
  setReleasedHabits: (_habits: ReleasedHabit[]) => void;
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
  const [releasedHabits, setReleasedHabits] = useState<ReleasedHabit[]>([]);
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
        setReleasedHabits(state.released_habits);
        cacheDismissed(state.offer_dismissed);
      })
      .catch(() => {
        // A failed load stays silent — the Return must never nag or crash the tab.
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return {
    eligible,
    weeks,
    arc,
    dismissed,
    releasedHabits,
    setArc,
    setDismissed,
    setReleasedHabits,
    mountedRef,
  };
}

interface LetGoActions {
  letGoVisible: boolean;
  markStarted: () => void;
  skipLetGo: () => void;
  release: (_habitIds: number[]) => Promise<void>;
  recommit: (_habitIds: number[]) => Promise<void>;
}

/** Own the let-go / re-commit moment: its visibility and the release/recommit calls. */
function useLetGoActions(
  mountedRef: MutableRefObject<boolean>,
  setReleasedHabits: (_habits: ReleasedHabit[]) => void,
): LetGoActions {
  const [letGoVisible, setLetGoVisible] = useState(false);
  const markStarted = useCallback((): void => setLetGoVisible(true), []);
  const skipLetGo = useCallback((): void => setLetGoVisible(false), []);
  const release = useCallback(
    async (habitIds: number[]): Promise<void> => {
      try {
        const rested = await mettaReturn.release(habitIds);
        if (mountedRef.current) setReleasedHabits(rested);
      } catch {
        // A failed release stays silent — letting go is a declinable invitation,
        // so even a rejected call (e.g. an empty selection the backend refuses)
        // closes the moment gently rather than stranding the person on the card.
      } finally {
        if (mountedRef.current) setLetGoVisible(false);
      }
    },
    [mountedRef, setReleasedHabits],
  );
  const recommit = useCallback(
    async (habitIds: number[]): Promise<void> => {
      const updated = await mettaReturn.recommit(habitIds);
      if (mountedRef.current) setReleasedHabits(updated);
    },
    [mountedRef, setReleasedHabits],
  );
  return { letGoVisible, markStarted, skipLetGo, release, recommit };
}

interface ArcLifecycle {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  leave: () => Promise<void>;
}

/** Drive the arc lifecycle, committing the local arc only after the API confirms. */
function useArcLifecycle(
  mountedRef: MutableRefObject<boolean>,
  setArc: (_arc: ReturnArc | null) => void,
  onStarted: () => void,
): ArcLifecycle {
  const start = useCallback(async (): Promise<void> => {
    const started = await mettaReturn.start();
    if (mountedRef.current) {
      setArc(started);
      onStarted();
    }
  }, [mountedRef, setArc, onStarted]);
  const runLifecycle = useCallback(
    async (call: () => Promise<ReturnArc>): Promise<void> => {
      const updated = await call();
      if (mountedRef.current) setArc(updated);
    },
    [mountedRef, setArc],
  );
  const pause = useCallback(() => runLifecycle(() => mettaReturn.pause()), [runLifecycle]);
  const resume = useCallback(() => runLifecycle(() => mettaReturn.resume()), [runLifecycle]);
  const leave = useCallback(async (): Promise<void> => {
    await mettaReturn.leave();
    if (mountedRef.current) setArc(null);
  }, [mountedRef, setArc]);
  return { start, pause, resume, leave };
}

/** The dismiss-offer action: hide the offer and persist the decline, best-effort. */
function useDismissOffer(setDismissed: (_dismissed: boolean) => void): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    setDismissed(true);
    cacheDismissed(true);
    try {
      await mettaReturn.dismissOffer();
    } catch {
      // A failed dismiss stays silent — the offer must never re-show once declined.
    }
  }, [setDismissed]);
}

export function useMettaReturn(): UseMettaReturnResult {
  const loaded = useLoadedReturn();
  const contractionActive = useContractionSignalActive();
  const { letGoVisible, markStarted, skipLetGo, release, recommit } = useLetGoActions(
    loaded.mountedRef,
    loaded.setReleasedHabits,
  );
  const { start, pause, resume, leave } = useArcLifecycle(
    loaded.mountedRef,
    loaded.setArc,
    markStarted,
  );
  const dismissOffer = useDismissOffer(loaded.setDismissed);
  const offerVisible =
    loaded.eligible && contractionActive && !loaded.dismissed && loaded.arc === null;

  return {
    eligible: loaded.eligible,
    weeks: loaded.weeks,
    arc: loaded.arc,
    offerVisible,
    letGoVisible,
    releasedHabits: loaded.releasedHabits,
    dismissOffer,
    start,
    pause,
    resume,
    leave,
    release,
    recommit,
    skipLetGo,
  };
}
