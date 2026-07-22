/**
 * Threshold fade — the "time to practice" moment. When the Practice player
 * gains focus, a light (canvas-colored) overlay covering the screen dissolves
 * from opaque to transparent, dimming the ground from the app's light surface
 * into the dark player: a brief, deliberate crossing of a threshold.
 *
 * Fully disabled under reduced motion — the overlay rests transparent (the
 * dark player shows immediately) and no animation is scheduled.
 *
 * The exit is intentionally NOT animated: leaving to another bottom tab lets
 * React Navigation hide the screen immediately, and delaying that departure
 * behind a reverse fade would add friction where none is wanted.
 */
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef } from 'react';
import { Animated } from 'react-native';

import { useReducedMotion } from './useReducedMotion';

import { motion } from '@/design/tokens';

export interface ThresholdFade {
  /** 1 = light ground fully covers the player; 0 = dark player shown. */
  overlayOpacity: Animated.Value;
}

export function useThresholdFade(): ThresholdFade {
  const reduced = useReducedMotion();
  const overlayOpacity = useRef(new Animated.Value(reduced ? 0 : 1)).current;

  useFocusEffect(
    useCallback(() => {
      if (reduced) {
        overlayOpacity.setValue(0);
        return;
      }
      overlayOpacity.setValue(1);
      const animation = Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: motion.threshold,
        useNativeDriver: true,
      });
      animation.start();
      return () => animation.stop();
    }, [reduced, overlayOpacity]),
  );

  return { overlayOpacity };
}
