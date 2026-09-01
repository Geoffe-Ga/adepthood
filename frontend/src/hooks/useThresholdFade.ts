/**
 * Threshold fade — the "time to practice" moment. When the Practice player
 * gains focus, a light (canvas-colored) overlay covering the screen dissolves
 * from opaque to transparent, dimming the ground from the app's light surface
 * into the dark player: a brief, deliberate crossing of a threshold.
 *
 * The fade is the flourish; the player underneath is the product, so the
 * overlay fails open. Its opaque state has a bounded lifetime enforced by a
 * plain timer that does not depend on focus firing, on the focus body running
 * to completion, or on the animation driver advancing a single frame. Whatever
 * goes wrong with the flourish, the player is reachable within
 * `FADE_COVER_LIFETIME_MS` — "covering the player" is not a state this UI can
 * rest in.
 *
 * Two timers arm that floor and both are deliberate. The mount-scoped one
 * covers the case where focus never fires or the focus body throws; the
 * focus-scoped one bounds every re-raise of the cover on refocus. They cannot
 * share a handle: the focus cleanup runs on blur and on every refocus, so
 * clearing a shared handle there would cancel the mount-scoped guarantee and
 * put the floor back under the focus lifecycle it exists to escape. Both
 * callbacks are the same idempotent `setValue(0)`, so both firing is harmless.
 *
 * Fully disabled under reduced motion — the overlay rests transparent (the
 * dark player shows immediately) and no animation is scheduled.
 *
 * The exit is intentionally NOT animated: leaving to another bottom tab lets
 * React Navigation hide the screen immediately, and delaying that departure
 * behind a reverse fade would add friction where none is wanted.
 */
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef } from 'react';
import { Animated } from 'react-native';

import { useReducedMotion } from './useReducedMotion';

import { motion } from '@/design/tokens';

/** Slack past the fade's own duration before the floor snaps the cover clear. */
const FADE_COVER_GRACE_MS = 200;
/** Upper bound on how long the light cover may rest over the player, ever. */
export const FADE_COVER_LIFETIME_MS = motion.threshold + FADE_COVER_GRACE_MS;

export interface ThresholdFade {
  /** 1 = light ground fully covers the player; 0 = dark player shown. */
  overlayOpacity: Animated.Value;
}

export function useThresholdFade(): ThresholdFade {
  const reduced = useReducedMotion();
  const overlayOpacity = useRef(new Animated.Value(reduced ? 0 : 1)).current;

  // Fail-open floor, independent of focus and of the animation driver.
  useEffect(() => {
    const floor = setTimeout(() => overlayOpacity.setValue(0), FADE_COVER_LIFETIME_MS);
    return () => clearTimeout(floor);
  }, [overlayOpacity]);

  useFocusEffect(
    useCallback(() => {
      if (reduced) {
        overlayOpacity.setValue(0);
        return;
      }
      overlayOpacity.setValue(1);
      // Armed before the animation exists so a raise that never animates is
      // still bounded.
      const floor = setTimeout(() => overlayOpacity.setValue(0), FADE_COVER_LIFETIME_MS);
      const animation = Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: motion.threshold,
        useNativeDriver: true,
      });
      animation.start();
      return () => {
        clearTimeout(floor);
        animation.stop();
      };
    }, [reduced, overlayOpacity]),
  );

  return { overlayOpacity };
}
