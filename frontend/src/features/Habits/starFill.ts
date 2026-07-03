import type { TierType } from './goalMarker';
import type { Goal, Habit } from './Habits.types';
import {
  calculateTodaysProgress,
  getGoalTarget,
  getMarkerPositions,
  getProgressPercentage,
} from './HabitUtils';

/**
 * Long-press-to-fill: holding a tier star on the goal modal's progress bar
 * animates the fill toward that star and, on arrival, logs exactly the units
 * needed for today's progress to land on that tier's target. This module owns
 * the pure math — which direction the bar moves, how many units get logged,
 * and how long the sweep takes — so the animation hook and gesture layer stay
 * thin and the invariants stay unit-testable.
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
 * marker position), the units to log on arrival (`deltaUnits`, negative when
 * the bar must move away from the tier's achieved side), and the sweep time.
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
 * Plan the fill for a long-pressed tier star, or `null` when there is nothing
 * to do (missing tiers, id-less onboarding habit, or today's progress already
 * sits on the star).
 *
 * `deltaUnits` is the daily-equivalent gap between the tier's target and
 * today's logged units, so it works in every direction: positive fills an
 * additive bar rightward or drains a subtractive one leftward (consuming
 * allowance), negative walks either bar back toward the star. The percents
 * come from the same canonical helpers the bar renders with, so the animation
 * always lands exactly where the star is drawn.
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

  const deltaUnits = getGoalTarget(tierGoal) - calculateTodaysProgress(habit, tz);
  if (Math.abs(deltaUnits) < DELTA_EPSILON) return null;

  const fromPercent = getProgressPercentage(habit, stretchGoal, tz);
  const toPercent = getMarkerPositions(lowGoal, clearGoal, stretchGoal)[tier];
  return {
    habitId: habit.id,
    tier,
    fromPercent,
    toPercent,
    deltaUnits,
    durationMs: sweepDurationMs(fromPercent, toPercent),
  };
};
