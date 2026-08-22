import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, corpusConsent, setTokenGetter } from '@/api';
import type { CorpusConsent } from '@/api';

/**
 * The consent decision, proven across the wire.
 *
 * The corpus ships opt-in: no fragment is written for an account that has not
 * agreed, so a screen wired to nothing leaves every corpus empty forever and
 * every reflection falling back to a recency window. Both halves stay green
 * through that — the screen's tests mock the client, and the router's tests
 * never see the client at all. This is the one place the two agree on the
 * paths, the verb, the source vocabulary, and the shape of "never asked".
 *
 * What it does not test is classification: sorting an entry costs a provider
 * call, and this lane has no provider. Consent is upstream of that and is the
 * part a person touches.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_UNPROCESSABLE = 422;

/** The source the app writes fragments for, and the only one with a switch. */
const JOURNAL = 'journal';

const email = `e2e-corpus-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-corpus-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

function forSource(states: CorpusConsent[], source: string): CorpusConsent {
  const found = states.find((state) => state.source === source);
  if (found === undefined) {
    throw new Error(`the server reported no state for "${source}"`);
  }
  return found;
}

describe('corpus-consent journey against a live server', () => {
  let sessionToken: string | null = null;
  let grantedAt: string | null = null;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('reports every source as un-asked and un-granted for a fresh account', async () => {
    // The opt-in promise, read rather than assumed: nothing is on, and the null
    // date is what tells the screen the question is still open rather than
    // answered "no".
    const states = await corpusConsent.list();

    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.granted).toBe(false);
      expect(state.decided_at).toBeNull();
    }
    expect(forSource(states, JOURNAL)).toBeDefined();
  });

  it('records a decision about one source and dates it', async () => {
    const state = await corpusConsent.set(JOURNAL, true);

    expect(state.source).toBe(JOURNAL);
    expect(state.granted).toBe(true);
    expect(state.decided_at).not.toBeNull();
    grantedAt = state.decided_at;
  });

  it('leaves every other source exactly where it was', async () => {
    // Per source, not blanket: a screen that read one answer as permission for
    // the rest would be collecting consent nobody gave.
    const states = await corpusConsent.list();

    for (const state of states) {
      const expected = state.source === JOURNAL;
      expect(state.granted).toBe(expected);
    }
  });

  it('treats a re-sent answer as the decision already on the record', async () => {
    // The log holds decisions, not requests: re-sending "yes" must not read as
    // a fresh agreement, so the date the account actually agreed survives.
    const state = await corpusConsent.set(JOURNAL, true);

    expect(state.granted).toBe(true);
    expect(state.decided_at).toBe(grantedAt);
  });

  it('hands the same answer to a cold start on a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    expect(forSource(await corpusConsent.list(), JOURNAL).granted).toBe(true);
  });

  it('withdraws, and reports a refusal on the record rather than an open question', async () => {
    const state = await corpusConsent.set(JOURNAL, false);

    expect(state.granted).toBe(false);
    // A date with `granted: false` is the whole point: this account has
    // answered, and the screen must not offer the question as though it had
    // never been asked.
    expect(state.decided_at).not.toBeNull();
    expect(state.decided_at).not.toBe(grantedAt);
  });

  it('refuses a source outside the ontology instead of storing a permission for nothing', async () => {
    const failure = await rejection(corpusConsent.set('everything', true));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
  });

  it("keeps one account's decision off another account", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads the subject from the JWT alone, so the neighbour sees an
    // untouched question rather than anything the first account decided.
    const state = forSource(await corpusConsent.list(), JOURNAL);
    expect(state.granted).toBe(false);
    expect(state.decided_at).toBeNull();
  });
});
