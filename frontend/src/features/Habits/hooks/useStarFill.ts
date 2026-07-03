import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

import type { TierType } from '../goalMarker';
import type { GoalModalProps, Habit } from '../Habits.types';
import { computeStarFillPlan, sweepDurationMs, type StarFillPlan } from '../starFill';

/**
 * The star-fill animation for the goal modal's progress bar: `begin(tier)`
 * sweeps the bar from its current position toward the pressed star and logs
 * the plan's delta on arrival; `release()` before arrival sweeps back to the
 * starting position and logs nothing.
 */

/** The two entry points the gesture layer drives. */
export interface StarFillControls {
  begin: (_tier: TierType) => void;
  release: () => void;
}

export interface StarFill extends StarFillControls {
  /** Percent to render while a fill/revert runs; `null` = show the static percent. */
  displayPercent: number | null;
}

interface UseStarFillArgs {
  habit: Habit;
  tz: string;
  /** The bar's static (prop-derived) percent, owned by the caller. */
  progressPercent: number;
  onLogUnit: GoalModalProps['onLogUnit'];
}

/** One linear constant-speed leg of the sweep; `onEnd` gets Animated's `finished`. */
const sweep = (
  anim: Animated.Value,
  toValue: number,
  duration: number,
  onEnd: (_finished: boolean) => void,
): void => {
  Animated.timing(anim, {
    toValue,
    duration,
    easing: Easing.linear,
    // Width is a layout prop — the native driver cannot animate it.
    useNativeDriver: false,
  }).start(({ finished }) => onEnd(finished));
};

/**
 * Drive the fill with a JS Animated value whose listener mirrors each frame
 * into React state, keeping the bar's `width` a plain percent string (the
 * shape the static render and its tests already rely on). The active plan
 * lives in a ref so the pan responders — created once — always act on the
 * current gesture rather than a stale closure.
 */
export const useStarFill = ({
  habit,
  tz,
  progressPercent,
  onLogUnit,
}: UseStarFillArgs): StarFill => {
  const anim = useRef(new Animated.Value(0)).current;
  const [displayPercent, setDisplayPercent] = useState<number | null>(null);
  const activeRef = useRef<StarFillPlan | null>(null);

  useEffect(() => {
    const id = anim.addListener(({ value }) => setDisplayPercent(value));
    return () => anim.removeListener(id);
  }, [anim]);

  // After a committed fill, the frozen frame equals the marker percent the
  // logged units produce; once the static percent catches up (the parent
  // habit re-renders), hand the bar back to the prop so it can never go stale.
  useEffect(() => {
    if (activeRef.current === null) setDisplayPercent(null);
  }, [progressPercent]);

  const begin = (tier: TierType): void => {
    if (activeRef.current !== null) return;
    const plan = computeStarFillPlan(habit, tier, tz);
    if (plan === null) return;
    activeRef.current = plan;
    setDisplayPercent(plan.fromPercent);
    anim.setValue(plan.fromPercent);
    sweep(anim, plan.toPercent, plan.durationMs, (finished) => {
      // An interrupted sweep (release/restart) is cleaned up by its interruptor.
      if (!finished || activeRef.current !== plan) return;
      activeRef.current = null;
      onLogUnit(plan.habitId, plan.deltaUnits);
    });
  };

  const release = (): void => {
    const plan = activeRef.current;
    if (plan === null) return; // no fill in flight (or it already committed)
    activeRef.current = null;
    anim.stopAnimation((current) => {
      sweep(anim, plan.fromPercent, sweepDurationMs(current, plan.fromPercent), (finished) => {
        if (finished && activeRef.current === null) setDisplayPercent(null);
      });
    });
  };

  return { displayPercent, begin, release };
};
