import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, SPACING } from '../design/tokens';

export interface ToastConfig {
  message: string;
  icon?: string;
  color?: string;
  duration?: number;
}

interface ToastProps extends ToastConfig {
  onDismiss: () => void;
}

const DEFAULT_DURATION_MS = 3000;
const ANIMATION_DURATION_MS = 300;
const SLIDE_DISTANCE = -80;

const buildAnimation = (
  opacity: Animated.Value,
  translateY: Animated.Value,
  toOpacity: number,
  toTranslateY: number,
) =>
  Animated.parallel([
    Animated.timing(opacity, {
      toValue: toOpacity,
      duration: ANIMATION_DURATION_MS,
      useNativeDriver: true,
    }),
    Animated.timing(translateY, {
      toValue: toTranslateY,
      duration: ANIMATION_DURATION_MS,
      useNativeDriver: true,
    }),
  ]);

const scheduleExit = (
  fadeOut: Animated.CompositeAnimation,
  onDismiss: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> => setTimeout(() => fadeOut.start(onDismiss), delayMs);

function useToastAnimation(duration: number | undefined, onDismiss: () => void) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(SLIDE_DISTANCE)).current;

  useEffect(() => {
    const fadeIn = buildAnimation(opacity, translateY, 1, 0);
    const fadeOut = buildAnimation(opacity, translateY, 0, SLIDE_DISTANCE);
    let timeout: ReturnType<typeof setTimeout>;

    fadeIn.start(() => {
      timeout = scheduleExit(fadeOut, onDismiss, duration ?? DEFAULT_DURATION_MS);
    });

    return () => clearTimeout(timeout);
  }, [opacity, translateY, duration, onDismiss]);

  return { opacity, translateY };
}

export default function Toast({ message, icon, color, duration, onDismiss }: ToastProps) {
  const { opacity, translateY } = useToastAnimation(duration, onDismiss);
  const borderColor = color ?? colors.tier.default;

  return (
    <Animated.View
      testID="toast-container"
      style={[
        styles.container,
        { opacity, transform: [{ translateY }], borderLeftColor: borderColor },
      ]}
    >
      {icon ? (
        <Text style={styles.icon} testID="toast-icon">
          {icon}
        </Text>
      ) : null}
      <View style={styles.content}>
        <Text style={styles.message} testID="toast-message">
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    backgroundColor: colors.background.card,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    ...shadows.medium,
  },
  icon: {
    fontSize: 24,
    marginRight: SPACING.md,
  },
  content: {
    flex: 1,
  },
  message: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '500',
  },
});
