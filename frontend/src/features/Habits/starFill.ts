import type { TierType } from './goalMarker';
import type { Goal, Habit } from './Habits.types';
import {
  getGoalTarget,
  getMarkerPositions,
  getProgressPercentage,
  percentForPeriodProgress,
  unitsInCurrentPeriod,
} from './HabitUtils';

/**
 * Long-press-to-fill: holding a tier star on the goal modal's progress bar
 * animates the fill toward that star and, on arrival, logs the units for one
 * occurrence of that tier — for a daily goal, exactly what today needs to land
 * on the star. A weekly or monthly goal's star sits at the whole period's
 * `target × frequency`, so there one hold logs one occurrence (`target`) toward
 * it, never past it, and the bar lands where that occurrence puts it; holding
 * once per session walks the week onto the star. Logging the whole period in
 * one hold would multiply what the person actually did by the frequency. A
 * walk-back is a correction, so it still returns the bar exactly to the star.
 * This module owns the pure math — which direction the bar moves, how many
 * units get logged, and how long the sweep takes — so the animation hook and
 * gesture layer stay thin and the invariants stay unit-testable.
 */

/** Hold time before a pressed star arms the fill animation. */
export const STAR_LONG_PRESS_MS = 400;

/** Time for the fill to sweep the full 0–100 bar; shorter hops scale down linearly. */
export const FULL_SWEEP_MS = 1500;

/** Duration floor so short hops still read as motion rather than a blink. */
export const MIN_SWEEP_MS = 250;

/** Movement beyond this many px turns a pending star long-press into a drag. */
export const DRAG_SLOP_PX = 8;

/** |delta| below this is "already on the star" — float dust from per-week targets. */
const DELTA_EPSILON = 1e-9;

const FULL_BAR_PERCENT = 100;

/**
 * Everything one star fill needs: where the bar starts (`fromPercent`, the
 * revert target on early release), where it lands (`toPercent`, the star's
 * marker position, or short of it when one occurrence does not reach the
 * star), the units to log on arrival (`deltaUnits`, negative when the bar must
 * move away from the tier's achieved side), and the sweep time.
 */
export interface StarFillPlan {
  habitId: number;
  tier: TierType;
  fromPercent: number;
  toPercent: number;
  deltaUnits: number;
  durationMs: number;
}

/** Constant-speed sweep: proportional to distance, floored for visibility. */
export const sweepDurationMs = (fromPercent: number, toPercent: number): number =>
  Math.max(MIN_SWEEP_MS, (Math.abs(toPercent - fromPercent) / FULL_BAR_PERCENT) * FULL_SWEEP_MS);

const findTier = (habit: Habit, tier: TierType): Goal | undefined =>
  habit.goals.find((g) => g.tier === tier);

/**
 * The units one hold logs: the gap to the star, capped at one occurrence of
 * the tier (`goal.target`) when filling. A daily goal's star *is* one
 * occurrence, so the cap only bites on a weekly or monthly cadence. A negative
 * gap is a walk-back and is returned whole.
 */
const holdDeltaUnits = (tierGoal: Goal, gapToStar: number): number =>
  gapToStar > 0 ? Math.min(gapToStar, tierGoal.target) : gapToStar;

/**
 * Plan the fill for a long-pressed tier star, or `null` when there is nothing
 * to do (missing tiers, id-less onboarding habit, or the period's progress
 * already sits on the star).
 *
 * `deltaUnits` is the gap between the tier's period target and the units
 * logged in that account-local period, capped at one occurrence of the tier
 * (see {@link holdDeltaUnits}), so it works in every direction: positive fills
 * an additive bar rightward or drains a subtractive one leftward (consuming
 * allowance), negative walks either bar back toward the star. The percents
 * come from the same canonical helpers the bar renders with, so the animation
 * lands exactly where the star is drawn when the hold reaches it, and exactly
 * where the logged occurrence puts the bar when it does not.
 */
export const computeStarFillPlan = (
  habit: Habit,
  tier: TierType,
  tz: string,
): StarFillPlan | null => {
  const lowGoal = findTier(habit, 'low');
  const clearGoal = findTier(habit, 'clear');
  const stretchGoal = findTier(habit, 'stretch');
  const tierGoal = findTier(habit, tier);
  if (habit.id == null || !lowGoal || !clearGoal || !stretchGoal || !tierGoal) return null;

  const gapToStar = getGoalTarget(tierGoal) - unitsInCurrentPeriod(habit, tierGoal, tz);
  if (Math.abs(gapToStar) < DELTA_EPSILON) return null;
  const deltaUnits = holdDeltaUnits(tierGoal, gapToStar);

  const periodProgress = unitsInCurrentPeriod(habit, stretchGoal, tz);
  const fromPercent = getProgressPercentage(habit, stretchGoal, tz);
  const reachesStar = Math.abs(gapToStar - deltaUnits) < DELTA_EPSILON;
  const toPercent = reachesStar
    ? getMarkerPositions(lowGoal, clearGoal, stretchGoal, periodProgress)[tier]
    : percentForPeriodProgress(habit, periodProgress + deltaUnits, stretchGoal);
  return {
    habitId: habit.id,
    tier,
    fromPercent,
    toPercent,
    deltaUnits,
    durationMs: sweepDurationMs(fromPercent, toPercent),
  };
};
