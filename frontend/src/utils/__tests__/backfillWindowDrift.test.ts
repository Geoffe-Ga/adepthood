/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { MAX_BACKFILL_DAYS } from '../backfillWindow';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The offer card omits a day the server would refuse, which means the client
 * carries a copy of a number the backend owns. A copy is only honest while
 * something fails when it drifts, so this derives the expectation from the
 * Python rather than restating it: widen or narrow the server's backfill
 * window and this goes red instead of the card promising a day the accept
 * silently replaces with today.
 *
 * The read goes through `@/testing/backendSource`, which is what makes
 * `backend-ci.yml` run this file on the backend change that would break it.
 */
const BACKEND_DATES = ['src', 'domain', 'dates.py'];

const BACKFILL_WINDOW = /^MAX_BACKFILL_DAYS = (\d+)$/m;

/** The single capture group of `pattern` in the backend module, as a number. */
function backendLimit(pattern: RegExp, name: string): number {
  const match = pattern.exec(readBackendSource(...BACKEND_DATES));
  if (match === null) {
    throw new Error(`${name} not found in backend/${BACKEND_DATES.join('/')}`);
  }
  return Number(match[1]);
}

describe('the client mirror of the completion backfill window', () => {
  it('backfills exactly as far as the server accepts', () => {
    expect(MAX_BACKFILL_DAYS).toBe(backendLimit(BACKFILL_WINDOW, 'MAX_BACKFILL_DAYS'));
  });
});
