import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

/**
 * Guards the test-timeout containment installed by `jest.setup.js`.
 *
 * When jest-circus times a test out it abandons the test function wherever it
 * is parked, so a `finally { jest.useRealTimers(); }` inside the body never
 * runs. React's `act()` decrements its scope depth only in the continuation of
 * the promise the body was awaiting, and flushes its queue only when the depth
 * it entered at was zero — so one abandoned `await act(async () => ...)` makes
 * every later `act()` in that file queue render work instead of committing it.
 * The neighbouring tests then render an empty tree and fail with
 * `Can't access .root on unmounted test renderer`, naming innocent components.
 *
 * That is why this is worth a subprocess: the failure only exists in a run
 * where a test actually times out, which no in-process assertion can stage.
 * The fixture stages it, and this asserts the blast radius is exactly one.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');
const JEST_BIN = join(FRONTEND_ROOT, 'node_modules', '.bin', 'jest');
const FIXTURE = join('__tests__', 'fixtures', 'timeoutCascade.test.tsx');

/** Short enough that the fixture's first test is abandoned mid-`act`. */
const FIXTURE_TIMEOUT_MS = 40;
/** Generous ceiling for the child process; it normally finishes in ~2s. */
const CHILD_BUDGET_MS = 120_000;

const PHANTOM_FAILURE = "Can't access .root on unmounted test renderer";

/**
 * Run the fixture in its own Jest process and return everything it printed.
 *
 * Jest exits non-zero here by design — the fixture's first test is *meant* to
 * time out — so a throw is the expected path, not an error.
 */
function runFixture(): string {
  const args = [
    '--runTestsByPath',
    FIXTURE,
    `--testTimeout=${FIXTURE_TIMEOUT_MS}`,
    // The fixtures directory is excluded from the normal suite; re-include it
    // by replacing the ignore list with Jest's default.
    '--testPathIgnorePatterns',
    '/node_modules/',
    // No worker process: this child only ever runs one suite.
    '--runInBand',
  ];
  try {
    return execFileSync(JEST_BIN, args, {
      cwd: FRONTEND_ROOT,
      encoding: 'utf8',
      timeout: CHILD_BUDGET_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
}

describe('test-timeout cascade containment', () => {
  it(
    'costs exactly one failure when a test times out inside act()',
    () => {
      const output = runFixture();

      // Non-emptiness first: a mistyped path collects zero tests and every
      // assertion below would then pass against a run that proved nothing.
      expect(output).toContain('Tests:');
      expect(output).toContain(`Exceeded timeout of ${FIXTURE_TIMEOUT_MS} ms`);

      // All four collected, and only the one built to time out actually failed.
      expect(output).toContain('Tests:       1 failed, 3 passed, 4 total');
      expect(output).not.toContain(PHANTOM_FAILURE);
    },
    CHILD_BUDGET_MS,
  );
});
