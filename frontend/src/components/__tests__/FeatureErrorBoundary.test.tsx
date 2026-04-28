import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { FeatureErrorBoundary } from '../FeatureErrorBoundary';

jest.mock('@/observability/sentry', () => ({
  reportException: jest.fn(),
  reportMessage: jest.fn(),
}));

// React Navigation's ``useNavigation`` is mocked so the test does not need
// a real ``NavigationContainer``.  ``addListener`` returns the unsubscribe
// callback the boundary stores during ``componentDidMount``.
const focusListeners: Array<() => void> = [];

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    addListener: (event: string, handler: () => void) => {
      if (event === 'focus') {
        focusListeners.push(handler);
      }
      return () => {
        const index = focusListeners.indexOf(handler);
        if (index !== -1) focusListeners.splice(index, 1);
      };
    },
  }),
}));

const { reportException } = jest.requireMock('@/observability/sentry') as {
  reportException: jest.Mock;
};

function Boom(): React.JSX.Element {
  throw new Error('feature boom!');
}

describe('FeatureErrorBoundary', () => {
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    reportException.mockClear();
    focusListeners.length = 0;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children when nothing throws', () => {
    const { getByText } = render(
      <FeatureErrorBoundary name="Habits">
        <Text>healthy feature</Text>
      </FeatureErrorBoundary>,
    );
    expect(getByText('healthy feature')).toBeTruthy();
  });

  it('reports caught exceptions with the boundary name as context', () => {
    render(
      <FeatureErrorBoundary name="Journal">
        <Boom />
      </FeatureErrorBoundary>,
    );
    expect(reportException).toHaveBeenCalledTimes(1);
    const call = reportException.mock.calls[0] as [Error, { errorBoundary: { name: string } }];
    expect(call[0].message).toBe('feature boom!');
    expect(call[1]).toMatchObject({
      errorBoundary: { boundary: 'FeatureErrorBoundary', name: 'Journal' },
    });
  });

  it('subscribes to navigation focus and resets on focus event (BUG-FE-UI-102)', () => {
    let shouldThrow = true;
    function MaybeBoom(): React.JSX.Element {
      if (shouldThrow) throw new Error('first render');
      return <Text>recovered</Text>;
    }

    const { getByTestId, getByText, queryByTestId } = render(
      <FeatureErrorBoundary name="Course">
        <MaybeBoom />
      </FeatureErrorBoundary>,
    );
    expect(getByTestId('feature-error-course')).toBeTruthy();
    expect(focusListeners).toHaveLength(1);

    // Simulate the user navigating away and back: fire the focus listener
    // inside ``act`` so React flushes the state-reset before we re-query.
    shouldThrow = false;
    act(() => {
      const handler = focusListeners[0];
      if (handler) handler();
    });

    expect(queryByTestId('feature-error-course')).toBeNull();
    expect(getByText('recovered')).toBeTruthy();
  });

  it('exposes a Try again button as a manual retry path', () => {
    let shouldThrow = true;
    function MaybeBoom(): React.JSX.Element {
      if (shouldThrow) throw new Error('manual retry case');
      return <Text>recovered manually</Text>;
    }

    const { getByText, queryByTestId } = render(
      <FeatureErrorBoundary name="Habits">
        <MaybeBoom />
      </FeatureErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.press(getByText('Try again'));
    expect(queryByTestId('feature-error-habits')).toBeNull();
    expect(getByText('recovered manually')).toBeTruthy();
  });
});
