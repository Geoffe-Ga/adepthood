import { setImmediate as realSetImmediate } from 'timers';

import { expect, it } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

/**
 * A deliberately failing suite, run as a subprocess by
 * `__tests__/timeoutCascade.test.ts`. It is NOT part of the normal suite:
 * `testPathIgnorePatterns` in `jest.config.js` excludes this directory, and the
 * meta-test re-includes it explicitly.
 *
 * The straggler twin of `timeoutCascadeRealTimers.test.tsx`. Here the first
 * test is not parked on one act scope that never settles: it loops, opening an
 * act scope that spans a real macrotask, then waiting out another real
 * macrotask between scopes -- the shape of RNTL's `waitFor` under fake timers,
 * and of the load-starved `JournalEntryScreenSaveRetry` tests that exposed it.
 * When jest-circus abandons it, it may be caught *between* scopes with none
 * open, and it resumes a macrotask or two later to open a fresh scope inside
 * the next test. That scope holds React's act depth above zero while the
 * neighbour renders, and the neighbour fails with
 * `Can't access .root on unmounted test renderer`.
 *
 * So: exactly one failure is the correct outcome. More is the bug.
 */

const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });

it('is abandoned while looping act() across real macrotasks, as RNTL waitFor does', async () => {
  render(<Text>first</Text>);
  for (;;) {
    await act(async () => {
      await macrotask();
    });
    await macrotask();
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
