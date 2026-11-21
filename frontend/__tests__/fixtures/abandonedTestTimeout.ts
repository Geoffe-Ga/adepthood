/**
 * The budget of the one fixture test built to time out, in ms.
 *
 * Only that test gets it, through its own `it(..., timeout)`. Its neighbours
 * keep Jest's default budget, so a slow machine can't time *them* out too and
 * turn the meta-test's "exactly one failure" into a flake.
 */
export const ABANDONED_TEST_TIMEOUT_MS = 40;
