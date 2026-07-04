import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { colors, SPACING } from '@/design/tokens';

interface ErrorFallbackProps {
  heading: string;
  onRetry: () => void;
  retryAccessibilityLabel: string;
  retryTestID?: string;
  retryStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** Shared presentational fallback skeleton used by both error boundaries. */
export function ErrorFallback({
  heading,
  onRetry,
  retryAccessibilityLabel,
  retryTestID,
  retryStyle,
  children,
}: ErrorFallbackProps): React.JSX.Element {
  return (
    <>
      <Text style={styles.heading}>{heading}</Text>
      {children}
      <TouchableOpacity
        accessibilityLabel={retryAccessibilityLabel}
        accessibilityRole="button"
        onPress={onRetry}
        style={retryStyle ? [styles.retry, retryStyle] : styles.retry}
        testID={retryTestID}
      >
        <Text style={styles.retryText}>Try again</Text>
      </TouchableOpacity>
    </>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: SPACING.md,
  },
  retry: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
  },
  retryText: {
    color: colors.text.light,
    fontWeight: '600',
  },
});
