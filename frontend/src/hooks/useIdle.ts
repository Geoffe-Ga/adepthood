/**
 * Track whether the user has paused (gone "idle") after activity.
 *
 * Call {@link UseIdleResult.bump} on each keystroke: it resets ``isIdle`` to
 * false and restarts the idle timer. After ``delayMs`` with no bump, ``isIdle``
 * flips true. The journal uses this to float the "Get Resonance" affordance in
 * once writing settles and tuck it away while the user types.
 *
 * {@link UseIdleResult.settle} is the escape hatch for a surface that opens onto
 * activity that is *already* over — an entry written days ago, say. There is no
 * pause to wait out there, so waiting for one shows the user nothing at all. It
 * is opt-in on purpose: the default stays "not idle until things go quiet", so
 * a consumer that never calls it behaves exactly as it always did.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Default idle delay — long enough to feel like a genuine pause, not a stutter. */
export const DEFAULT_IDLE_DELAY_MS = 1800;

export interface UseIdleOptions {
  delayMs?: number;
}

export interface UseIdleResult {
  isIdle: boolean;
  /** Record activity: hides the idle state and restarts the pause timer. */
  bump: () => void;
  /**
   * Declare the surface already settled, without waiting for a pause. A later
   * {@link UseIdleResult.bump} takes precedence, so real activity still wins.
   */
  settle: () => void;
}

export function useIdle({ delayMs = DEFAULT_IDLE_DELAY_MS }: UseIdleOptions = {}): UseIdleResult {
  const [isIdle, setIsIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const bump = useCallback(() => {
    setIsIdle(false);
    clear();
    timerRef.current = setTimeout(() => setIsIdle(true), delayMs);
  }, [delayMs, clear]);

  // Cancel any pending timer as well as flipping the flag: a timer left running
  // would later re-assert an idle state the caller may have already bumped away.
  const settle = useCallback(() => {
    clear();
    setIsIdle(true);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { isIdle, bump, settle };
}
