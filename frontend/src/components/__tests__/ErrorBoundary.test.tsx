import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ErrorBoundary } from '../ErrorBoundary';

jest.mock('@/observability/sentry', () => ({
  reportException: jest.fn(),
  reportMessage: jest.fn(),
}));

const { reportException } = jest.requireMock('@/observability/sentry') as {
  reportException: jest.Mock;
};

function Boom(): React.JSX.Element {
  throw new Error('boom!');
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    reportException.mockClear();
    // React logs caught errors at console.error during render — silence the
    // expected noise so the test output reads cleanly.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children when nothing throws', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Text>healthy</Text>
      </ErrorBoundary>,
    );
    expect(getByText('healthy')).toBeTruthy();
  });

  it('renders the fallback and forwards the exception to Sentry', () => {
    const { getByTestId } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(getByTestId('error-boundary')).toBeTruthy();
    expect(reportException).toHaveBeenCalledTimes(1);
    const call = reportException.mock.calls[0] as [Error, { react: { componentStack: string } }];
    expect(call[0].message).toBe('boom!');
    expect(call[1]).toMatchObject({
      errorBoundary: { boundary: 'ErrorBoundary' },
    });
    expect(call[1].react.componentStack).toEqual(expect.any(String));
  });

  it('exposes a Try again button that resets the error state', () => {
    let shouldThrow = true;
    function MaybeBoom(): React.JSX.Element {
      if (shouldThrow) throw new Error('first render fails');
      return <Text>recovered</Text>;
    }

    const { getByTestId, getByText, queryByTestId } = render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );
    expect(getByTestId('error-boundary')).toBeTruthy();

    // Flip the toggle so the next render succeeds, then tap Try again.
    shouldThrow = false;
    fireEvent.press(getByTestId('error-boundary-retry'));

    expect(queryByTestId('error-boundary')).toBeNull();
    expect(getByText('recovered')).toBeTruthy();
  });
});
