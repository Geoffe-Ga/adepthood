/**
 * Wheel-of-wholeness balance overlay for the Map spiral.
 *
 * This layers a *balance* reading on top of the existing spiral: each Aspect
 * (stage) reads as "thin" or "alive" by how full its fullness fraction is. The
 * framing is deliberately a wheel, not a ladder — copy and emphasis speak to
 * wholeness across every Aspect rather than rank or altitude, so nothing here
 * implies one Aspect is above another.
 */

/** Fullness at or above which an Aspect reads as "alive" rather than "thin". */
export const FULLNESS_ALIVE_THRESHOLD = 0.5;

/**
 * Rendered opacity for a thin vs. alive Aspect node. Opacity is a unitless
 * emphasis dial (not a colour/spacing token): the alive value is fully opaque
 * and the thin value is muted so a fuller Aspect reads as more present without
 * re-sorting or re-colouring the spiral.
 */
const THIN_OPACITY = 0.55;
const ALIVE_OPACITY = 1;

/**
 * Emphasis style for a stage node given its fullness: a higher fullness maps to
 * a higher opacity, so an alive Aspect renders visually more present than a thin
 * one. Returns a plain style fragment the caller appends to the node's style.
 *
 * @param fullness - The Aspect's fullness fraction (expected ``0..1``).
 * @returns A ``{ opacity }`` fragment; alive at/above the threshold, else thin.
 */
export function emphasisStyle(fullness: number): { opacity: number } {
  return { opacity: fullness >= FULLNESS_ALIVE_THRESHOLD ? ALIVE_OPACITY : THIN_OPACITY };
}

/**
 * Balance-not-ladder copy for the three whole-wheel states. Every string is
 * free of gamified rank/altitude language (level, climb, ascend, higher, rank,
 * altitude, ladder) so the reading stays invitational.
 */
export const BALANCE_COPY = {
  allThin: 'Every Aspect is still thin — a whole wheel waiting to be filled.',
  mixed: 'Your balance right now: some Aspects are alive, others are still thin.',
  allAlive: 'Your wheel reads full and balanced across every Aspect.',
} as const;

/** The balance state a wheel reads as, keyed to {@link BALANCE_COPY}. */
export type BalanceState = keyof typeof BALANCE_COPY;

/** Aspects on a full wheel; an absent stage in the map reads as thin. */
const WHEEL_ASPECT_COUNT = 10;

/**
 * Pick the balance state for a fullness map, read against a full wheel: absent
 * stages count as thin. ``allAlive`` requires every Aspect on the wheel to be
 * alive; ``allThin`` requires none; anything between is ``mixed``. An empty map
 * (the error/loading fallback) reads as ``allThin`` — the neutral "whole wheel
 * waiting to be filled".
 *
 * @param fullnessByStage - Fullness fraction keyed by stage number.
 * @returns The matching {@link BalanceState}.
 */
export function summaryFor(fullnessByStage: Readonly<Record<number, number>>): BalanceState {
  const aliveCount = Object.values(fullnessByStage).filter(
    (f) => f >= FULLNESS_ALIVE_THRESHOLD,
  ).length;
  if (aliveCount === 0) return 'allThin';
  if (aliveCount >= WHEEL_ASPECT_COUNT) return 'allAlive';
  return 'mixed';
}
