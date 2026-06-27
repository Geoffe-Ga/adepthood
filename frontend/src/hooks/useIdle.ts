/**
 * Track whether the user has paused (gone "idle") after activity.
 *
 * Call {@link UseIdleResult.bump} on each keystroke: it resets ``isIdle`` to
 * false and restarts the idle timer. After ``delayMs`` with no bump, ``isIdle``
 * flips true. The journal uses this to float the "Get Resonance" affordance in
 * once writing settles and tuck it away while the user types.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Default idle delay — long enough to feel like a genuine pause, not a stutter. */
export const DEFAULT_IDLE_DELAY_MS = 1800;

export interface UseIdleOptions {
  delayMs?: number;
}

export interface UseIdleResult {
  isIdle: boolean;
  bump: () => void;
}

export function useIdle({ delayMs = DEFAULT_IDLE_DELAY_MS }: UseIdleOptions = {}): UseIdleResult {
  const [isIdle, setIsIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = useCallback(() => {
    setIsIdle(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsIdle(true), delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { isIdle, bump };
}
