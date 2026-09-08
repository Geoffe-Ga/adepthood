/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { MAX_BACKDATE_HOURS, MAX_FUTURE_SKEW_SECONDS, MAX_SESSION_HOURS } from '../constants';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The manual-log form refuses an out-of-window sitting before it spends a
 * request, which means the client carries a copy of three numbers the backend
 * owns. A copy is only honest while something fails when it drifts, so this
 * derives the expectations from the Python rather than restating them: widen
 * or narrow the server's window and this goes red instead of the user meeting
 * a 422 the form promised could not happen.
 *
 * The read goes through `@/testing/backendSource`, which is what makes
 * `backend-ci.yml` run this file on the backend change that would break it.
 */
const BACKEND_SCHEMA = ['src', 'schemas', 'practice.py'];

const FUTURE_SKEW = /^MAX_FUTURE_SKEW = timedelta\(seconds=(\d+)\)$/m;
const BACKDATE_WINDOW = /^MAX_BACKDATE_WINDOW = timedelta\(hours=(\d+)\)$/m;
const SESSION_DURATION = /^MAX_SESSION_DURATION = timedelta\(hours=(\d+)\)$/m;

/** The single capture group of `pattern` in the backend schema, as a number. */
function backendLimit(pattern: RegExp, name: string): number {
  const match = pattern.exec(readBackendSource(...BACKEND_SCHEMA));
  if (match === null) {
    throw new Error(`${name} not found in backend/${BACKEND_SCHEMA.join('/')}`);
  }
  return Number(match[1]);
}

describe('the client mirror of the practice-session window', () => {
  it('allows a session to end exactly as far ahead as the server tolerates', () => {
    expect(MAX_FUTURE_SKEW_SECONDS).toBe(backendLimit(FUTURE_SKEW, 'MAX_FUTURE_SKEW'));
  });

  it('backdates exactly as far as the server accepts', () => {
    expect(MAX_BACKDATE_HOURS).toBe(backendLimit(BACKDATE_WINDOW, 'MAX_BACKDATE_WINDOW'));
  });

  it('caps a single sitting at exactly the server maximum', () => {
    expect(MAX_SESSION_HOURS).toBe(backendLimit(SESSION_DURATION, 'MAX_SESSION_DURATION'));
  });
});
