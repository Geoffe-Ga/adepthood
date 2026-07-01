/**
 * Depth-reinforcing motion for the floated journal surfaces — the writing
 * sheet settling in on mount, and cards pressing down when tapped. Every
 * animation here is short, native-driven, and gated on ``useReducedMotion``:
 * when reduce-motion is on the hooks return the resting state and run no
 * animation, so layout is identical and nothing interpolates.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';

export { usePressScale, PRESS_DURATION_MS, PRESS_SCALE } from '@/hooks/usePressScale';
export type { PressScale } from '@/hooks/usePressScale';

/** Sheet settle-in: a brief fade + a few-px lift into place. */
export const SETTLE_DURATION_MS = 220;
export const SETTLE_DISTANCE = 6;

export interface SettleStyle {
  opacity: Animated.AnimatedInterpolation<number> | Animated.Value;
  transform: { translateY: Animated.AnimatedInterpolation<number> }[];
}

/**
 * Animated style for a surface that settles in when it mounts. With reduced
 * motion the value starts at its resting position (opacity 1, no offset) and no
 * animation is scheduled.
 */
export function useSettleIn(reduced: boolean): SettleStyle {
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      anim.setValue(1);
      return;
    }
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: SETTLE_DURATION_MS,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, anim]);

  return useMemo(
    () => ({
      opacity: anim,
      transform: [
        { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [SETTLE_DISTANCE, 0] }) },
      ],
    }),
    [anim],
  );
}
