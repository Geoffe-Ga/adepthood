import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

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
    backgroundColor: '#fff',
  },
  content: {
    padding: 24,
    paddingTop: 48,
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: '#b00020',
    marginBottom: 12,
  },
  message: {
    fontSize: 16,
    color: '#222',
    marginBottom: 16,
  },
  stack: {
    fontSize: 12,
    color: '#555',
    fontFamily: 'monospace',
  },
});
