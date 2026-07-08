import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { LoadErrorRetry, LoadingBlock } from '../LoadErrorRetry';

describe('LoadingBlock', () => {
  it('renders a container findable by testID', () => {
    const { getByTestId } = render(
      <LoadingBlock style={{}} color="#000" testID="loading-container" />,
    );
    expect(getByTestId('loading-container')).toBeTruthy();
  });

  it('renders a spinner findable by spinnerTestID without a container testID', () => {
    const { getByTestId } = render(
      <LoadingBlock style={{}} color="#000" spinnerTestID="loading-spinner" />,
    );
    expect(getByTestId('loading-spinner')).toBeTruthy();
  });
});

describe('LoadErrorRetry', () => {
  it('renders the message text', () => {
    const { getByText } = render(
      <LoadErrorRetry
        message="Something went wrong."
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={{}}
        retryTextStyle={{}}
        retryTestID="retry-button"
      />,
    );
    expect(getByText('Something went wrong.')).toBeTruthy();
  });

  it('renders the retry button and fires onRetry when pressed', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <LoadErrorRetry
        message="Failed"
        onRetry={onRetry}
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={{}}
        retryTextStyle={{}}
        retryTestID="retry-button"
      />,
    );
    fireEvent.press(getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when onRetry is not provided', () => {
    const { queryByTestId } = render(
      <LoadErrorRetry
        message="Failed"
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={{}}
        retryTextStyle={{}}
        retryTestID="retry-button"
      />,
    );
    expect(queryByTestId('retry-button')).toBeNull();
  });

  it('exposes the retry button via accessibility label when provided', () => {
    const { getByLabelText, queryByLabelText, rerender } = render(
      <LoadErrorRetry
        message="Failed"
        onRetry={jest.fn()}
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={{}}
        retryTextStyle={{}}
        retryTestID="retry-button"
        retryAccessibilityLabel="Retry"
      />,
    );
    expect(getByLabelText('Retry')).toBeTruthy();

    rerender(
      <LoadErrorRetry
        message="Failed"
        onRetry={jest.fn()}
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={{}}
        retryTextStyle={{}}
        retryTestID="retry-button"
      />,
    );
    expect(queryByLabelText('Retry')).toBeNull();
  });

  it('accepts a style array for retryStyle without error', () => {
    const { getByTestId } = render(
      <LoadErrorRetry
        message="Failed"
        onRetry={jest.fn()}
        containerStyle={{}}
        messageStyle={{}}
        retryStyle={[{}, {}]}
        retryTextStyle={{}}
        retryTestID="retry-button"
      />,
    );
    expect(getByTestId('retry-button')).toBeTruthy();
  });
});
