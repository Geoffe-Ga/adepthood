import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, SPACING } from '../design/tokens';
import { reportException } from '../observability/sentry';

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
 *
 * BUG-FE-UI-101: ``componentDidCatch`` previously logged to the console and
 * dropped the error on the floor — production crashes were invisible to ops.
 * Every catch now also forwards to {@link reportException} (a Sentry stub
 * today, the real SDK once the DSN lands) with the React component stack
 * attached as a structured context.
 *
 * The fallback UI surfaces a "Try again" button that resets ``error`` to
 * ``null`` so the subtree remounts without forcing the user to kill and
 * relaunch the app.  The exception message is intentionally kept on the
 * page so a support handoff can copy it verbatim — it is not raw user
 * input.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportException(error, {
      react: { componentStack: info.componentStack ?? '' },
      errorBoundary: { boundary: 'ErrorBoundary' },
    });
  }

  private handleRetry = (): void => {
    // BUG-FE-UI-101: a top-level boundary that never resets traps the
    // user on the error screen until they kill the app.  Clearing
    // ``error`` triggers a re-render of ``this.props.children``, which
    // re-mounts the entire tree and gives the app a clean slate.
    this.setState({ error: null });
  };

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
          <TouchableOpacity
            accessibilityLabel="Try again"
            accessibilityRole="button"
            onPress={this.handleRetry}
            style={styles.retry}
            testID="error-boundary-retry"
          >
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
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
  retry: {
    alignSelf: 'flex-start',
    marginTop: SPACING.xl,
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
