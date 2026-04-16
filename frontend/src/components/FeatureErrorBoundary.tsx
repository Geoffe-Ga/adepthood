import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, SPACING } from '@/design/tokens';

interface FeatureErrorBoundaryProps {
  /** Display name of the crashing surface, used in the recovery UI. */
  name: string;
  children: React.ReactNode;
}

interface FeatureErrorBoundaryState {
  error: Error | null;
}

/**
 * BUG-FRONTEND-INFRA-019 — per-feature boundary so a crash in Journal does
 * not take down Habits, Practice, Course, or Map. When caught, the user sees
 * a scoped recovery card with a "Try again" button that remounts the subtree.
 */
export class FeatureErrorBoundary extends React.Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  state: FeatureErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[FeatureErrorBoundary:${this.props.name}]`, error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const { name } = this.props;
    return (
      <View style={styles.container} testID={`feature-error-${name.toLowerCase()}`}>
        <Text style={styles.heading}>{name} hit a snag</Text>
        <Text style={styles.body}>
          Something went wrong while loading this section. The rest of the app is still usable.
        </Text>
        <Text style={styles.message}>{this.state.error.message}</Text>
        <TouchableOpacity
          accessibilityLabel={`Retry loading ${name}`}
          accessibilityRole="button"
          onPress={this.handleReset}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
    padding: SPACING.xl,
    justifyContent: 'center',
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: SPACING.md,
  },
  body: {
    fontSize: 15,
    color: colors.text.primary,
    marginBottom: SPACING.md,
    lineHeight: 22,
  },
  message: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.xl,
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
