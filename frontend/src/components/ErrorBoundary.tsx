import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, SPACING } from '../design/tokens';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level boundary that renders a visible error screen instead of a blank
 * page when a child throws during render. Essential for production web builds
 * where devs debug from mobile browsers without readily-available dev tools.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <View style={styles.container} testID="error-boundary">
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.heading}>Something went wrong</Text>
          <Text style={styles.guidance}>
            Try closing and reopening the app. If this keeps happening, copy the details below and
            send them to support so we can fix it.
          </Text>
          <Text style={styles.message}>{this.state.error.message}</Text>
          {this.state.error.stack ? (
            <Text style={styles.stack}>{this.state.error.stack}</Text>
          ) : null}
        </ScrollView>
      </View>
    );
  }
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.card,
  },
  content: {
    padding: SPACING.xl,
    paddingTop: SPACING.xxl + SPACING.lg,
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: SPACING.md,
  },
  guidance: {
    fontSize: 15,
    color: colors.text.primary,
    marginBottom: SPACING.lg,
    lineHeight: 22,
  },
  message: {
    fontSize: 16,
    color: colors.text.primary,
    marginBottom: SPACING.lg,
  },
  stack: {
    fontSize: 12,
    color: colors.text.secondaryAccessible,
    fontFamily: 'monospace',
  },
});
