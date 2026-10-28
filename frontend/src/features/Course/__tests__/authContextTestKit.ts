/**
 * The ``AuthContext`` stand-in for the CourseScreen specs.
 *
 * The screen reads the committed credential so a mounted account switch can
 * reload Course for the incoming owner (#3343). ``useAuth`` throws outside a
 * provider and these specs render the screen directly, so each swaps this in
 * via ``jest.mock('@/context/AuthContext', () => require('./authContextTestKit'))``.
 * It holds account 1's credential: the account every spec scopes itself to with
 * ``setActiveUser(1)``. Specs that switch accounts mid-render drive their own
 * credential (see ``CourseScreenAccountSwitch.test.tsx``).
 */

/** Account 1's session token, matching the specs' ``captureSessionToken`` mock. */
export const TEST_SESSION_TOKEN = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';

/** Just the slice the screen reads; the rest of the context is unused here. */
export function useAuth(): { token: string } {
  return { token: TEST_SESSION_TOKEN };
}
