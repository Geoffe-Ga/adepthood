/**
 * Depth-reinforcing motion for the floated journal surfaces — the writing
 * sheet settling in on mount, and cards pressing down when tapped. Every
 * animation here is short, native-driven, and gated on ``useReducedMotion``:
 * when reduce-motion is on the hooks return the resting state and run no
 * animation, so layout is identical and nothing interpolates.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';

/** Sheet settle-in: a brief fade + a few-px lift into place. */
export const SETTLE_DURATION_MS = 220;
export const SETTLE_DISTANCE = 6;

/** Card press-in: a barely-there scale-down for a "press into the desk" feel. */
export const PRESS_DURATION_MS = 90;
export const PRESS_SCALE = 0.98;

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

export interface PressScale {
  scale: Animated.Value;
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * A press-feedback scale for a card. ``onPressIn``/``onPressOut`` drive a subtle
 * scale-down and back; both are no-ops under reduced motion (the scale stays at
 * 1, so the card still gets ``TouchableOpacity``'s default opacity dip only).
 */
export function usePressScale(reduced: boolean): PressScale {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number): void => {
    if (reduced) return;
    Animated.timing(scale, {
      toValue,
      duration: PRESS_DURATION_MS,
      useNativeDriver: true,
    }).start();
  };

  return {
    scale,
    onPressIn: () => animateTo(PRESS_SCALE),
    onPressOut: () => animateTo(1),
  };
}
