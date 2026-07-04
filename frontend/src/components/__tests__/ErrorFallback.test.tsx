import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { ErrorFallback } from '../ErrorFallback';

describe('ErrorFallback', () => {
  it('renders the given heading and the Try again button label', () => {
    const { getByText } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
      />,
    );
    expect(getByText('Something went wrong')).toBeTruthy();
    expect(getByText('Try again')).toBeTruthy();
  });

  it('renders children between the heading and the retry button', () => {
    const { getByText } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
      >
        <Text>marker</Text>
      </ErrorFallback>,
    );
    expect(getByText('marker')).toBeTruthy();
  });

  it('calls onRetry exactly once when the button is pressed', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={onRetry}
        retryAccessibilityLabel="Try again"
        retryTestID="error-boundary-retry"
      />,
    );
    fireEvent.press(getByTestId('error-boundary-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('exposes an accessible button role and the given accessibility label', () => {
    const { getByLabelText } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
      />,
    );
    const button = getByLabelText('Try again');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Try again');
  });

  it('passes retryTestID through onto the button when provided', () => {
    const { getByTestId } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
        retryTestID="error-boundary-retry"
      />,
    );
    expect(getByTestId('error-boundary-retry')).toBeTruthy();
  });

  it('still renders without a retryTestID', () => {
    const { getByText, queryByTestId } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
      />,
    );
    expect(getByText('Try again')).toBeTruthy();
    expect(queryByTestId('error-boundary-retry')).toBeNull();
  });

  it('merges retryStyle onto the button style', () => {
    const { getByTestId } = render(
      <ErrorFallback
        heading="Something went wrong"
        onRetry={jest.fn()}
        retryAccessibilityLabel="Try again"
        retryTestID="error-boundary-retry"
        retryStyle={{ marginTop: 20 }}
      />,
    );
    const flattened = StyleSheet.flatten(getByTestId('error-boundary-retry').props.style);
    expect(flattened).toMatchObject({ marginTop: 20 });
  });
});
