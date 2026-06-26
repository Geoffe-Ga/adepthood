import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { FeatureErrorBoundary } from '../FeatureErrorBoundary';

jest.mock('@/observability/sentry', () => ({
  reportException: jest.fn(),
}));

// React Navigation's ``useNavigation`` is mocked so the test does not need
// a real ``NavigationContainer``.  ``addListener`` returns the unsubscribe
// callback the boundary stores during ``componentDidMount``.  A second
// listener array stands in for a replacement navigator (deep-link reset)
// so the #272 re-subscribe test can prove the old subscription is released.
const focusListeners: Array<() => void> = [];
const mockSecondNavigatorListeners: Array<() => void> = [];
const mockNavigatorState = { useSecond: false };

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => {
    const target = mockNavigatorState.useSecond ? mockSecondNavigatorListeners : focusListeners;
    return {
      addListener: (event: string, handler: () => void) => {
        if (event === 'focus') {
          target.push(handler);
        }
        return () => {
          const index = target.indexOf(handler);
          if (index !== -1) target.splice(index, 1);
        };
      },
    };
  },
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
    mockSecondNavigatorListeners.length = 0;
    mockNavigatorState.useSecond = false;
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

  it('re-subscribes when the navigator identity changes post-mount (#272)', () => {
    let shouldThrow = true;
    function MaybeBoom(): React.JSX.Element {
      if (shouldThrow) throw new Error('deep-link crash');
      return <Text>after reset</Text>;
    }

    const { rerender, getByTestId, getByText, queryByTestId } = render(
      <FeatureErrorBoundary name="Map">
        <MaybeBoom />
      </FeatureErrorBoundary>,
    );
    expect(getByTestId('feature-error-map')).toBeTruthy();
    expect(focusListeners).toHaveLength(1);

    // A deep-link reset replaces the navigator object identity.
    mockNavigatorState.useSecond = true;
    rerender(
      <FeatureErrorBoundary name="Map">
        <MaybeBoom />
      </FeatureErrorBoundary>,
    );

    // The stale subscription on the OLD navigator was released…
    expect(focusListeners).toHaveLength(0);
    expect(mockSecondNavigatorListeners).toHaveLength(1);

    // …and focus events from the NEW navigator still clear the crash.
    shouldThrow = false;
    act(() => {
      mockSecondNavigatorListeners[0]?.();
    });
    expect(queryByTestId('feature-error-map')).toBeNull();
    expect(getByText('after reset')).toBeTruthy();
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

describe('FeatureErrorBoundary — raw message gating (audit-ux-05)', () => {
  const devGlobal = global as { __DEV__?: boolean };
  const originalDev = devGlobal.__DEV__;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    reportException.mockClear();
    focusListeners.length = 0;
    mockSecondNavigatorListeners.length = 0;
    mockNavigatorState.useSecond = false;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    devGlobal.__DEV__ = originalDev;
    errorSpy.mockRestore();
  });

  function SecretBoom(): React.JSX.Element {
    throw new Error('secret-internal-detail');
  }

  it('hides the raw error message in production builds (__DEV__ false)', () => {
    devGlobal.__DEV__ = false;
    const { queryByText, getByText } = render(
      <FeatureErrorBoundary name="Habits">
        <SecretBoom />
      </FeatureErrorBoundary>,
    );
    // The internal detail must never reach a production user…
    expect(queryByText('secret-internal-detail')).toBeNull();
    // …but the friendly explanation and retry control still render.
    expect(getByText(/hit a snag/)).toBeTruthy();
    expect(getByText('Try again')).toBeTruthy();
  });

  it('shows the raw error message in dev builds (__DEV__ true)', () => {
    devGlobal.__DEV__ = true;
    const { getByText } = render(
      <FeatureErrorBoundary name="Habits">
        <SecretBoom />
      </FeatureErrorBoundary>,
    );
    expect(getByText('secret-internal-detail')).toBeTruthy();
    expect(getByText(/hit a snag/)).toBeTruthy();
  });
});
