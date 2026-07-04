/**
 * Wheel-of-wholeness balance overlay: each Aspect reads thin/alive, a wheel
 * not a ladder. The read is carried through accessibility labels only —
 * unlocked stages always render at full opacity, so the Map never looks
 * washed out when the wheel reads thin (or hasn't loaded yet).
 */

/** Fullness at or above which an Aspect reads as "alive" rather than "thin". */
export const FULLNESS_ALIVE_THRESHOLD = 0.5;
