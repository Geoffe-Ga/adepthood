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

/** Balance-not-ladder copy for the three whole-wheel states (no rank language). */
export const BALANCE_COPY = {
  allThin: 'Every Aspect is still thin — a whole wheel waiting to be filled.',
  mixed: 'Your balance right now: some Aspects are alive, others are still thin.',
  allAlive: 'Your wheel reads full and balanced across every Aspect.',
} as const;

/** The balance state a wheel reads as, keyed to {@link BALANCE_COPY}. */
export type BalanceState = keyof typeof BALANCE_COPY;

/** Aspects on a full wheel; an absent stage in the map reads as thin. */
const WHEEL_ASPECT_COUNT = 10;

/** Balance state for a fullness map, read against a full wheel of ten Aspects. */
export function summaryFor(fullnessByStage: Readonly<Record<number, number>>): BalanceState {
  const aliveCount = Object.values(fullnessByStage).filter(
    (f) => f >= FULLNESS_ALIVE_THRESHOLD,
  ).length;
  if (aliveCount === 0) return 'allThin';
  // Absent stages count as thin, so all ten must be present and alive for allAlive.
  if (aliveCount >= WHEEL_ASPECT_COUNT) return 'allAlive';
  return 'mixed';
}
