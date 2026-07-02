/**
 * The seam that decides whether a contraction (a natural easing-off) is
 * currently observed for the person. The Return offer is only ever surfaced
 * when this returns true AND the person is eligible.
 *
 * It returns ``false`` for now: the descriptive contraction detector lands in a
 * later slice, and until it does the offer stays quietly out of sight. Keeping
 * the decision behind this single named function means wiring the real detector
 * later is a one-line change, and every offer/accept path is already built and
 * tested against it.
 */
export function isContractionSignalActive(): boolean {
  return false;
}
