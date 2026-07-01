/**
 * Card press-feedback scale — a barely-there scale-down when a surface is
 * tapped, for a "press into the desk" feel. Shared across features so a card
 * anywhere can wire the same tactile response; native-driven and gated on
 * reduced motion so the polish never costs accessibility.
 */
import { useRef } from 'react';
import { Animated } from 'react-native';

/** Card press-in: a barely-there scale-down for a "press into the desk" feel. */
export const PRESS_DURATION_MS = 90;
export const PRESS_SCALE = 0.98;

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
