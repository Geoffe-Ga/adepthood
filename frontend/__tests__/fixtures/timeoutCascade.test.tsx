import { expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

/**
 * A deliberately failing suite, run as a subprocess by
 * `__tests__/timeoutCascade.test.ts`. It is NOT part of the normal suite:
 * `testPathIgnorePatterns` in `jest.config.js` excludes this directory, and the
 * meta-test re-includes it explicitly.
 *
 * The first test is built to be abandoned by a jest-circus timeout while parked
 * inside `await act(async () => ...)` under fake timers — the exact condition
 * that used to leave React's act scope depth above zero and make every later
 * render in the file commit nothing. The three neighbours are ordinary renders
 * that must keep passing: they are the ones that used to fail with
 * `Can't access .root on unmounted test renderer` through no fault of their own.
 *
 * So: exactly one failure is the correct outcome. Four is the bug.
 */

it('is abandoned mid-await under fake timers, as a timed-out test is', async () => {
  jest.useFakeTimers();
  try {
    render(<Text>first</Text>);
    await act(async () => {
      // Never settles: nothing advances the fake clock, so the test times out
      // here and its `finally` below is never reached.
      await new Promise((resolve) => {
        setTimeout(resolve, 10_000);
      });
    });
  } finally {
    jest.useRealTimers();
  }
});

it('neighbour one renders normally', () => {
  render(<Text>second</Text>);
  expect(screen.getByText('second')).toBeTruthy();
});

it('neighbour two renders normally', () => {
  render(<Text>third</Text>);
  expect(screen.getByText('third')).toBeTruthy();
});

it('neighbour three renders normally', () => {
  render(<Text>fourth</Text>);
  expect(screen.getByText('fourth')).toBeTruthy();
});
