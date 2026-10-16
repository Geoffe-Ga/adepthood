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
import { useCallback, useEffect, useState } from 'react';

import { useContractionSignalActive } from './contractionSignal';
import { useReturnOfferState } from './useReturnOfferState';

import { mettaReturn } from '@/api';
import type { ReleasedHabit, ReturnArc, ReturnWeek } from '@/api';

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

interface LetGoActions {
  letGoVisible: boolean;
  markStarted: () => void;
  skipLetGo: () => void;
  release: (_habitIds: number[]) => Promise<void>;
  recommit: (_habitIds: number[]) => Promise<void>;
}

/**
 * Own the let-go / re-commit moment: its visibility and the release/recommit calls.
 *
 * Visibility resets with the owner ``session``, not with ``current``: a
 * same-account token renewal mints a new ``current`` fence, and keying the
 * reset to it closed the prompt mid-choice (#3374). Requests still capture the
 * latest credential and stay fenced by ``current``.
 */
function useLetGoActions(
  current: () => boolean,
  session: string | null,
  token: string | null,
  setReleasedHabits: (_habits: ReleasedHabit[]) => void,
): LetGoActions {
  const [letGoVisible, setLetGoVisible] = useState(false);
  useEffect(() => setLetGoVisible(false), [session]);
  const markStarted = useCallback((): void => setLetGoVisible(true), []);
  const skipLetGo = useCallback((): void => {
    if (current()) setLetGoVisible(false);
  }, [current]);
  const release = useCallback(
    async (habitIds: number[]): Promise<void> => {
      if (!current() || token === null) return;
      try {
        const rested = await mettaReturn.release(habitIds, token);
        if (current()) setReleasedHabits(rested);
      } catch {
        // A failed release stays silent — letting go is a declinable invitation,
        // so even a rejected call (e.g. an empty selection the backend refuses)
        // closes the moment gently rather than stranding the person on the card.
      } finally {
        if (current()) setLetGoVisible(false);
      }
    },
    [current, token, setReleasedHabits],
  );
  const recommit = useCallback(
    async (habitIds: number[]): Promise<void> => {
      if (!current() || token === null) return;
      try {
        const updated = await mettaReturn.recommit(habitIds, token);
        if (current()) setReleasedHabits(updated);
      } catch {
        // Mirrors `release`'s hardening: recommit is dispatched fire-and-forget
        // (`void recommit(...)`), so a rejected call resolves silently and leaves
        // the resting list untouched rather than raising an unhandled rejection.
      }
    },
    [current, token, setReleasedHabits],
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
  current: () => boolean,
  token: string | null,
  setArc: (_arc: ReturnArc | null) => void,
  onStarted: () => void,
): ArcLifecycle {
  const start = useCallback(async (): Promise<void> => {
    if (!current() || token === null) return;
    const started = await mettaReturn.start(token);
    if (current()) {
      setArc(started);
      onStarted();
    }
  }, [current, token, setArc, onStarted]);
  const runLifecycle = useCallback(
    async (call: () => Promise<ReturnArc>): Promise<void> => {
      if (!current()) return;
      const updated = await call();
      if (current()) setArc(updated);
    },
    [current, setArc],
  );
  const pause = useCallback(
    () => runLifecycle(() => mettaReturn.pause(token ?? undefined)),
    [runLifecycle, token],
  );
  const resume = useCallback(
    () => runLifecycle(() => mettaReturn.resume(token ?? undefined)),
    [runLifecycle, token],
  );
  const leave = useCallback(async (): Promise<void> => {
    if (!current() || token === null) return;
    await mettaReturn.leave(token);
    if (current()) setArc(null);
  }, [current, token, setArc]);
  return { start, pause, resume, leave };
}

/** How a caller wants the Return state read. */
export interface UseMettaReturnOptions {
  /** False skips the read entirely, e.g. while the habits ring is declined. */
  enabled?: boolean;
  /** Re-read the state whenever this changes. */
  refreshKey?: number;
}

export function useMettaReturn(options: UseMettaReturnOptions = {}): UseMettaReturnResult {
  const loaded = useReturnOfferState(options);
  const contractionActive = useContractionSignalActive();
  const { letGoVisible, markStarted, skipLetGo, release, recommit } = useLetGoActions(
    loaded.current,
    loaded.session,
    loaded.token,
    loaded.setReleasedHabits,
  );
  const { start, pause, resume, leave } = useArcLifecycle(
    loaded.current,
    loaded.token,
    loaded.setArc,
    markStarted,
  );
  const dismissOffer = loaded.dismissOffer;
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
