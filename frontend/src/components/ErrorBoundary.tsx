import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, SPACING } from '../design/tokens';
import { reportException } from '../observability/sentry';

import { ErrorFallback } from './ErrorFallback';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const PRODUCTION_GUIDANCE =
  'Try closing and reopening the app. If this keeps happening, let us know what you were doing when it broke so we can fix it.';
const DEVELOPMENT_GUIDANCE =
  'Try closing and reopening the app. If this keeps happening, copy the details below and send them to support so we can fix it.';

/**
 * Top-level boundary that renders a visible error screen instead of a blank
 * page when a child throws during render. Essential for production web builds
 * where devs debug from mobile browsers without readily-available dev tools.
 *
 * BUG-FE-UI-101: ``componentDidCatch`` previously logged to the console and
 * dropped the error on the floor — production crashes were invisible to ops.
 * Every catch now also forwards to {@link reportException} with the React
 * component stack attached as a structured context. That reporter posts to
 * Sentry when a DSN is configured and writes the console record either way;
 * the payload it builds carries no user content — see
 * ``observability/sentryEnvelope.ts``.
 *
 * The fallback UI surfaces a "Try again" button that resets ``error`` to
 * ``null`` so the subtree remounts without forcing the user to kill and
 * relaunch the app.  The exception message and stack render in development
 * builds only: a thrown error's text can carry library names and internal
 * detail that a production reader cannot use, so there they get plain guidance
 * instead (the full report still reaches Sentry via ``componentDidCatch``).
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
          <ErrorFallback
            heading="Something went wrong"
            onRetry={this.handleRetry}
            retryAccessibilityLabel="Try again"
            retryTestID="error-boundary-retry"
            retryStyle={styles.retrySpacing}
          >
            <Text style={styles.guidance}>
              {__DEV__ ? DEVELOPMENT_GUIDANCE : PRODUCTION_GUIDANCE}
            </Text>
            {/* Issue #272: the verbatim JS stack leaks file paths and internal
                function names, and the raw message can carry the same kind of
                internals — both are development-only. Production users get
                the plain guidance above. */}
            {__DEV__ ? <Text style={styles.message}>{this.state.error.message}</Text> : null}
            {__DEV__ && this.state.error.stack ? (
              <Text style={styles.stack} testID="error-boundary-stack">
                {this.state.error.stack}
              </Text>
            ) : null}
          </ErrorFallback>
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
  retrySpacing: {
    marginTop: SPACING.xl,
  },
});
