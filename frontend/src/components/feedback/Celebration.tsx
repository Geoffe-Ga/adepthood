/**
 * A small arrival celebration: when `active` flips true the children pulse once
 * (a gentle scale up-and-back) to mark the moment — e.g. a weekly goal reached.
 * Under reduced motion there is no pulse (children render at rest). If `onDismiss`
 * is given it fires after the celebration window, for transient/auto-dismissing
 * uses; persistent callers (a goal-reached label) simply omit it.
 */
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

import { motion } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const PULSE_SCALE = 1.06;
const DISMISS_MS = 2400;

interface CelebrationProps {
  children: React.ReactNode;
  /** Play the pulse / start the auto-dismiss timer when this is true. */
  active: boolean;
  /** Optional auto-dismiss callback, fired ~DISMISS_MS after activation. */
  onDismiss?: () => void;
  testID?: string;
}

export function Celebration({
  children,
  active,
  onDismiss,
  testID = 'celebration',
}: CelebrationProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) return undefined;
    if (!reduced) {
      Animated.sequence([
        Animated.timing(scale, {
          toValue: PULSE_SCALE,
          duration: motion.fast,
          useNativeDriver: true,
        }),
        Animated.timing(scale, { toValue: 1, duration: motion.base, useNativeDriver: true }),
      ]).start();
    }
    if (!onDismiss) return undefined;
    const timer = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [active, reduced, scale, onDismiss]);

  return (
    <Animated.View testID={testID} style={{ transform: [{ scale }] }}>
      {children}
    </Animated.View>
  );
}
