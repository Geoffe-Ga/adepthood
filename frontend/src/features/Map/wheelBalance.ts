/** Wheel-of-wholeness balance overlay: each Aspect reads thin/alive, a wheel not a ladder. */

/** Fullness at or above which an Aspect reads as "alive" rather than "thin". */
export const FULLNESS_ALIVE_THRESHOLD = 0.5;

/** Opacity emphasis dial (not a token): thin nodes are muted, alive nodes fully opaque. */
const THIN_OPACITY = 0.55;
const ALIVE_OPACITY = 1;

/** Opacity fragment for a node: fuller Aspect reads more present (alive vs thin). */
export function emphasisStyle(fullness: number): { opacity: number } {
  return { opacity: fullness >= FULLNESS_ALIVE_THRESHOLD ? ALIVE_OPACITY : THIN_OPACITY };
}
