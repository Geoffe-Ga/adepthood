/**
 * App-wide entrance motion: a brief fade + small upward settle when an element
 * mounts, staggerable by index. Lives in the shared layer so any screen —
 * including the journal's floated surfaces — can adopt the same vocabulary.
 *
 * Fully disabled under reduced motion — the value starts at its resting state
 * (opacity 1, no offset) and no animation is scheduled, so layout is identical.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';

import { useReducedMotion } from './useReducedMotion';

import { motion } from '@/design/tokens';

/** Per-index delay so a list can cascade in rather than appearing at once. */
const STAGGER_MS = 40;

export interface EntranceStyle {
  opacity: Animated.Value;
  transform: { translateY: Animated.AnimatedInterpolation<number> }[];
}

export function useEntrance(index = 0): EntranceStyle {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      anim.setValue(1);
      return;
    }
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: motion.base,
      delay: index * STAGGER_MS,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, anim, index]);

  return useMemo(
    () => ({
      opacity: anim,
      transform: [
        { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [motion.settleY, 0] }) },
      ],
    }),
    [anim],
  );
}
