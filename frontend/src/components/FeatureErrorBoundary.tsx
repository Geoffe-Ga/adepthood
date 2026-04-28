import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, SPACING } from '@/design/tokens';
import { reportException } from '@/observability/sentry';

interface FeatureErrorBoundaryProps {
  /** Display name of the crashing surface, used in the recovery UI. */
  name: string;
  children: React.ReactNode;
}

interface FeatureErrorBoundaryInnerProps extends FeatureErrorBoundaryProps {
  /**
   * Subscribe-to-route-focus hook.
   *
   * Injected by the public {@link FeatureErrorBoundary} wrapper because
   * React class components cannot use hooks directly — passing the
   * subscription as a prop lets the class boundary react to navigation
   * focus events without needing functional-component machinery
   * (BUG-FE-UI-102).
   */
  onFocus: (handler: () => void) => () => void;
}

interface FeatureErrorBoundaryState {
  error: Error | null;
}

/**
 * BUG-FRONTEND-INFRA-019 — per-feature boundary so a crash in Journal does
 * not take down Habits, Practice, Course, or Map. When caught, the user sees
 * a scoped recovery card with a "Try again" button that remounts the subtree.
 *
 * BUG-FE-UI-101: every catch is forwarded to the Sentry shim with the
 * boundary name and the React component stack so an alert in Sentry
 * carries enough context to land in the right tab without a repro.
 *
 * BUG-FE-UI-102: the boundary subscribes to ``navigation.addListener('focus',
 * …)`` so that when the user switches tabs and comes back to a crashed
 * surface, the error is cleared automatically (a quiet re-render is far
 * less hostile than asking them to tap "Try again" first).  ``onFocus``
 * is injected as a prop because class components cannot use hooks; the
 * functional wrapper below adapts the React Navigation hook to that
 * prop signature.
 */
class FeatureErrorBoundaryClass extends React.Component<
  FeatureErrorBoundaryInnerProps,
  FeatureErrorBoundaryState
> {
  state: FeatureErrorBoundaryState = { error: null };

  private unsubscribe: (() => void) | null = null;

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { error };
  }

  componentDidMount(): void {
    // BUG-FE-UI-102: subscribe AFTER mount so the unsubscribe is
    // available for ``componentWillUnmount``; subscribing in the
    // constructor would race the hook lifecycle.
    this.unsubscribe = this.props.onFocus(this.handleReset);
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportException(error, {
      react: { componentStack: info.componentStack ?? '' },
      errorBoundary: { boundary: 'FeatureErrorBoundary', name: this.props.name },
    });
  }

  private handleReset = (): void => {
    // ``setState`` is a no-op when the next state matches the current
    // state, so the focus-listener can fire on every navigation event
    // without forcing extra renders on the success path.
    if (this.state.error !== null) {
      this.setState({ error: null });
    }
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

/**
 * Public wrapper that adapts the React Navigation focus hook into the
 * ``onFocus`` prop the class boundary expects.
 *
 * **Must be rendered inside a NavigationContainer** — the
 * route-focus reset semantics depend on it.  The top-level
 * ``ErrorBoundary`` (which sits outside the container in ``App.tsx``)
 * is the right tool for crashes that escape every feature boundary;
 * tests that render a feature shell in isolation should mock
 * ``@react-navigation/native``.
 */
export function FeatureErrorBoundary(props: FeatureErrorBoundaryProps): React.JSX.Element {
  const navigation = useNavigation();
  // Stable subscriber identity so the class component's
  // ``componentDidMount`` registers exactly one listener per mount
  // even when the parent re-renders.
  const onFocus = React.useCallback(
    (handler: () => void) => navigation.addListener('focus', handler),
    [navigation],
  );
  return <FeatureErrorBoundaryClass {...props} onFocus={onFocus} />;
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
