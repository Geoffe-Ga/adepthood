/**
 * The seam that decides whether a contraction (a natural easing-off) is
 * currently observed for the person. The Return offer is only ever surfaced
 * when this returns true AND the person is eligible.
 *
 * It reads the shared contraction-signal store, which the journal resonance
 * pass feeds each time it observes a contraction. A reactive selector so the
 * Return offer on the Journal shelf re-renders the moment the signal flips.
 */
import { useContractionSignalStore } from '@/store/useContractionSignalStore';

/** Reactive read of whether a contraction is currently observed for the person. */
export function useContractionSignalActive(): boolean {
  return useContractionSignalStore((s) => s.active);
}
