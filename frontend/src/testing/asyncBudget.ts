/**
 * Jest's per-test timeout, mirrored so a test can check the budget below it.
 *
 * `jest.config.js` deliberately sets no `testTimeout`, so every unit suite
 * runs under Jest's default of five seconds.
 */
export const JEST_TEST_TIMEOUT_MS = 5000;

/**
 * How long a `waitFor` / `findBy*` waits, on the wall clock, before failing.
 *
 * Applied to every suite by `jest.setup.js` through RNTL's `configure`; no
 * test file sets its own. Prefer `settle()` from `./asyncSettle` wherever the
 * only pending work is an already-resolved mock -- that has no deadline at all.
 * This budget is for what remains: work a test cannot flush, only observe.
 *
 * Sized for #2943. RNTL's one-second default was thin enough that a correct
 * screen failed on render cost alone: with Jest's default workers plus eight
 * CPU burners, 20-35 of the 350 tests in the suites #2943 names failed per run
 * while they still waited through it (most of those waits are now
 * `settle()`). At 2.5s, on a 4-core box, the whole suite passed 9610/9610
 * under `--coverage` with four burners, and
 * `JournalEntryScreenResonanceExplainer` -- which carried a private
 * five-second override for `--coverage` -- passed 9 of 10 runs without it
 * under the same load; the one miss was its cold first test hitting the
 * five-second test timeout, not a find expiring.
 *
 * It must stay well below `JEST_TEST_TIMEOUT_MS`: a wait that spends the whole
 * budget still leaves room for the test's render and a failing assertion that
 * names the missing element, rather than an anonymous test timeout.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 2500;
