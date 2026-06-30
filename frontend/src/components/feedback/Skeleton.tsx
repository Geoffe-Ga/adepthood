/**
 * Loading placeholders that replace raw full-screen spinners. A `Skeleton` is a
 * rounded block that gently shimmers (opacity loop); `SkeletonCard` stacks a few
 * into a card silhouette. Under reduced motion the shimmer is omitted entirely —
 * a plain static block at the resting opacity — so nothing animates.
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { BORDER_RADIUS, SPACING, surface, surfaceShadow } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const SHIMMER_MIN = 0.4;
const SHIMMER_MAX = 0.75;
const SHIMMER_MS = 900;

interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The animated branch — only mounted when motion is allowed, so the loop hook
 * is never scheduled under reduced motion. */
function ShimmerBlock({
  width,
  height,
  style,
  testID,
}: Required<Pick<SkeletonProps, 'width' | 'height'>> &
  Pick<SkeletonProps, 'style' | 'testID'>): React.JSX.Element {
  const opacity = useRef(new Animated.Value(SHIMMER_MIN)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: SHIMMER_MAX,
          duration: SHIMMER_MS,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: SHIMMER_MIN,
          duration: SHIMMER_MS,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View testID={testID} style={[styles.base, { width, height, opacity }, style]} />;
}

export function Skeleton({
  width = '100%',
  height = 16,
  style,
  testID = 'skeleton',
}: SkeletonProps): React.JSX.Element {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <View testID={testID} style={[styles.base, { width, height, opacity: SHIMMER_MIN }, style]} />
    );
  }
  return <ShimmerBlock width={width} height={height} style={style} testID={testID} />;
}

export function SkeletonCard({ testID = 'skeleton-card' }: { testID?: string }): React.JSX.Element {
  return (
    <View testID={testID} style={styles.card}>
      <Skeleton width="55%" height={20} testID="skeleton-card-title" />
      <Skeleton width="100%" height={14} />
      <Skeleton width="80%" height={14} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: surface.sunken, borderRadius: BORDER_RADIUS.sm },
  card: {
    gap: SPACING.sm,
    padding: SPACING.md,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.md,
    ...surfaceShadow.card,
  },
});
