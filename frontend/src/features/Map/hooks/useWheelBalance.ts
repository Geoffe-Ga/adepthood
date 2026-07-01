/**
 * Fetch the wheel-of-wholeness balance on mount and expose a fullness map the
 * Map spiral can join by stage number.
 *
 * The overlay is additive: on a fetch error (or an empty reading) the map stays
 * empty so every Aspect reads as thin — the neutral "whole wheel waiting"
 * fallback — and the spiral never breaks. The auth token is supplied by the API
 * client's registered token getter (mirroring ``stageService.loadStages``), so
 * the hook needs no ``AuthProvider`` of its own.
 */

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

/**
 * Load the wheel-of-wholeness balance once on mount.
 *
 * @returns The fullness-by-stage map plus ``loading`` / ``error`` flags. On any
 *   failure the map is left empty (all-thin fallback) and ``error`` is set.
 */
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
