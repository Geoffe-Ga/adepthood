/* eslint-env jest */
/* global describe, test, expect */
import { REQUEST_HEADER_VOCABULARY } from '../index';

import { readBackendSource } from '@/testing/backendSource';

/**
 * A header this client sends is only sendable if the backend's CORS allow-list
 * names it. When it does not, a cross-origin browser refuses the request at the
 * preflight: the call never reaches the server, nothing is logged, and the
 * client sees a bare `TypeError` it cannot attribute. The two lists grew apart
 * exactly that way — `Idempotency-Key` was added on this side and on four call
 * sites, and every one of them was dead on web.
 *
 * So the expectation is derived from the backend source rather than restated
 * here: a second copy of today's list would pass by construction and go stale
 * in lockstep with the bug. The read goes through `@/testing/backendSource`,
 * which is what makes backend CI run this file on the change that would break
 * it.
 *
 * The relation asserted is containment, not equality: the backend may allow a
 * header this client does not send yet (`X-Request-ID` is allowed so a browser
 * client can set its own correlation id), and an allow-list entry is a
 * deliberate decision on the server's side. What must never happen is the
 * other direction — this client naming a header the preflight will refuse.
 */
const BACKEND_APP = ['src', 'main.py'];

const ALLOWED_HEADERS_BLOCK = /^ALLOWED_HEADERS = \[([^\]]*)\]/m;
const QUOTED_HEADER = /"([^"]+)"/g;

function backendAllowedHeaders(): Set<string> {
  const block = ALLOWED_HEADERS_BLOCK.exec(readBackendSource(...BACKEND_APP));
  if (block === null) {
    throw new Error(`ALLOWED_HEADERS not found in backend/${BACKEND_APP.join('/')}`);
  }
  const [, entries = ''] = block;
  const headers = [...entries.matchAll(QUOTED_HEADER)].flatMap(([, name]) =>
    name === undefined ? [] : [name.toLowerCase()],
  );
  if (headers.length === 0) {
    throw new Error(`ALLOWED_HEADERS in backend/${BACKEND_APP.join('/')} parsed as empty`);
  }
  return new Set(headers);
}

describe("the client's request-header vocabulary", () => {
  test('is entirely inside the CORS allow-list the backend answers preflights with', () => {
    const allowed = backendAllowedHeaders();
    const refused = Object.values(REQUEST_HEADER_VOCABULARY).filter(
      (header) => !allowed.has(header.toLowerCase()),
    );
    expect(refused).toEqual([]);
  });

  test('is not empty, so the check above cannot pass by reading nothing', () => {
    expect(Object.values(REQUEST_HEADER_VOCABULARY).length).toBeGreaterThan(0);
  });
});
