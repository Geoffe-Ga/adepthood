/* eslint-env jest */
/* global describe, test, expect */
import { SEED_UPLOAD_LIMIT, SEED_UPLOAD_WINDOW_MS } from '../seedUploadPacing';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The client paces a folder import under the endpoint's rate limit so a big
 * folder does not turn into a wall of refusals. The limit lives in Python and
 * is enforced there; the client's mirror is only honest while something fails
 * when the two drift, which is what reading the backend source here does.
 *
 * Two halves: the number itself, and that `POST /corpus/import` is still the
 * route that limit is declared on.
 */
const BACKEND_SCHEMA = ['src', 'schemas', 'journal_upload.py'];
const BACKEND_ROUTER = ['src', 'routers', 'corpus.py'];

const UPLOAD_RATE_LIMIT = /^UPLOAD_RATE_LIMIT = "(\d+)\/(second|minute|hour)"$/m;

const WINDOW_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
};

function backendLimit(): { amount: number; windowMs: number } {
  const match = UPLOAD_RATE_LIMIT.exec(readBackendSource(...BACKEND_SCHEMA));
  if (match === null) {
    throw new Error(`UPLOAD_RATE_LIMIT not found in backend/${BACKEND_SCHEMA.join('/')}`);
  }
  return { amount: Number(match[1]), windowMs: WINDOW_MS[match[2] ?? ''] ?? Number.NaN };
}

describe("the client's upload pace", () => {
  test('is exactly the limit the endpoint enforces', () => {
    const { amount, windowMs } = backendLimit();

    expect(SEED_UPLOAD_LIMIT).toBe(amount);
    expect(SEED_UPLOAD_WINDOW_MS).toBe(windowMs);
  });

  test('is the limit declared on the import route', () => {
    const router = readBackendSource(...BACKEND_ROUTER);

    expect(router).toMatch(/"\/import",[\s\S]{0,200}?\)\n@limiter\.limit\(UPLOAD_RATE_LIMIT\)/);
  });
});
