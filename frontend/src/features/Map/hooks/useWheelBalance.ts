/** Fetch-on-mount wheel-of-wholeness balance; empty map on error reads all-thin. */

import { useEffect, useState } from 'react';

import { wheel } from '../../../api';
import { clampProgress } from '../services/stageService';

/** Fetch-on-mount wheel balance: fullness per stage, plus loading/error state. */
export interface WheelBalanceState {
  /** Clamped 0..1 fullness keyed by stage number; ``{}`` on error/loading. */
  fullnessByStage: Record<number, number>;
  loading: boolean;
  error: string | null;
}

/** Join the wheel aspects into a stage-number → clamped-fullness map. */
const toFullnessByStage = (aspects: { stage_number: number; fullness: number }[]) =>
  Object.fromEntries(aspects.map((a) => [a.stage_number, clampProgress(a.fullness)]));

/** Load the wheel balance once on mount; empty map + ``error`` on any failure. */
export function useWheelBalance(): WheelBalanceState {
  const [fullnessByStage, setFullnessByStage] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fail = (err: unknown) => {
      if (!active) return;
      // Leave the map empty so the overlay degrades to all-thin; the spiral
      // itself is unaffected by a failed wheel read.
      setError(err instanceof Error ? err.message : 'Failed to load wheel balance');
    };
    // ``Promise.resolve`` wraps the call so a synchronous throw (not just a
    // rejected promise) routes through the same all-thin fallback path.
    Promise.resolve()
      .then(() => wheel.get())
      .then((balance) => {
        if (active) setFullnessByStage(toFullnessByStage(balance.aspects));
      })
      .catch(fail)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { fullnessByStage, loading, error };
}
