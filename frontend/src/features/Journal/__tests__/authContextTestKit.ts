import { setActiveUser } from '@/storage/userScope';

// The authenticated fixture owns user 1's device namespace.
setActiveUser(1);

/**
 * The ``AuthContext`` stand-in for the ``JournalEntryScreen`` specs.
 *
 * The screen reads the auth-hydrated IANA zone so that accepting a completion
 * suggestion refreshes the habit store on the user's day boundary rather than
 * the device's. ``useAuth`` throws outside a provider and these specs render
 * the screen directly instead of mounting the app, so each swaps this in via
 * ``jest.mock('@/context/AuthContext', () => require('./authContextTestKit'))``.
 * One definition of the zone the specs assume, rather than eighteen.
 */

/** The zone every JournalEntryScreen spec renders under. */
export const TEST_TIMEZONE = 'UTC';

/** Just the slice the screen reads; the rest of the context is unused here. */
export function useAuth(): { userTimezone: string; token: string; authStatus: string } {
  return {
    userTimezone: TEST_TIMEZONE,
    token: 'test.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test',
    authStatus: 'authenticated',
  };
}
