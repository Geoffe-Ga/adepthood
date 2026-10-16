/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { touchTarget } from '../../../design/tokens';
import RetryButton, { RETRY_LABEL } from '../RetryButton';

describe('RetryButton', () => {
  it('renders the visible label "Try again"', () => {
    const { getByText } = render(<RetryButton onRetry={jest.fn()} testID="x" />);
    expect(getByText('Try again')).toBeTruthy();
  });

  it('keeps the accessibility label in sync with the visible text', () => {
    const { getByTestId, getByText } = render(<RetryButton onRetry={jest.fn()} testID="x" />);
    const button = getByTestId('x');
    const visibleText = getByText('Try again').props.children;
    expect(button.props.accessibilityLabel).toBe('Try again');
    expect(visibleText).toBe('Try again');
    expect(button.props.accessibilityLabel).toBe(visibleText);
  });

  it('calls onRetry once when pressed', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(<RetryButton onRetry={onRetry} testID="x" />);
    fireEvent.press(getByTestId('x'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('meets the minimum touch target, so a failed read is retryable by touch (#3344)', () => {
    const { getByTestId } = render(<RetryButton onRetry={jest.fn()} testID="x" />);
    const style = StyleSheet.flatten(getByTestId('x').props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('exports RETRY_LABEL as "Try again"', () => {
    expect(RETRY_LABEL).toBe('Try again');
  });
});
