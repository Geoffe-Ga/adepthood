import { expect, it } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

/**
 * A deliberately failing suite, run as a subprocess by
 * `__tests__/timeoutCascade.test.ts`. It is NOT part of the normal suite:
 * `testPathIgnorePatterns` in `jest.config.js` excludes this directory, and the
 * meta-test re-includes it explicitly.
 *
 * The real-timer twin of `timeoutCascade.test.tsx`. The first test is abandoned
 * by a jest-circus timeout while parked inside `await act(async () => ...)` on
 * a promise that nothing will ever settle — no fake clock to drain, so the
 * fake-timer containment cannot help. That is the shape a load-starved suite
 * takes when a test runs past `testTimeout` inside a real-timer `act`.
 *
 * Two things must hold for the neighbours:
 *  - they render and commit normally (the act scope depth was restored), and
 *  - the abandoned body never resumes into them. `resumed` records whether the
 *    code after the abandoned `await` ever ran; a containment that *resolved*
 *    the abandoned scope instead of rejecting it would flip it, and the
 *    stray body would then run inside whichever test happened to be live.
 *
 * So: exactly one failure is the correct outcome. Four is the bug.
 */

let resumed = false;

it('is abandoned mid-await on a real-timer act, as a load-starved test is', async () => {
  render(<Text>first</Text>);
  await act(async () => {
    // Never settles: no timer, no mock, nothing — the test times out here.
    await new Promise<never>(() => undefined);
  });
  resumed = true;
});

it('neighbour one renders normally', () => {
  render(<Text>second</Text>);
  expect(screen.getByText('second')).toBeTruthy();
});

it('neighbour two renders normally', () => {
  render(<Text>third</Text>);
  expect(screen.getByText('third')).toBeTruthy();
});

it('neighbour three renders normally, and the abandoned body never resumed', () => {
  render(<Text>fourth</Text>);
  expect(screen.getByText('fourth')).toBeTruthy();
  expect(resumed).toBe(false);
});
