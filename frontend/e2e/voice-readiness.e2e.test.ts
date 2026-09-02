import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, corpus, corpusConsent, setTokenGetter } from '@/api';

/**
 * Where the voice comes from, proven across the wire.
 *
 * The signal is three-state, and the reason is a fact neither half's own tests
 * can see. The corpus ships opt-in, so nothing an un-consented account writes is
 * ever sorted: for that account — the state most real accounts are in — "keep
 * writing and it will fill up" is false, permanently. A two-state readiness
 * would say exactly that. The screen's tests mock the client and the router's
 * tests never see it, so this is the one place the two agree that a fresh
 * account is told about the *decision*, that agreeing changes the sentence, and
 * that neither of those is the same thing as being ready.
 *
 * What it does not test is arriving. Reaching the threshold means sorting a
 * fortnight of entries, which costs a provider call apiece, and this lane has no
 * provider. The threshold arithmetic is unit-tested; what needs a live server is
 * the consent axis, which is the part a person touches.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

/** The source the app writes fragments for, and the only one with a switch. */
const JOURNAL = 'journal';

const email = `e2e-readiness-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-readiness-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('voice-readiness journey against a live server', () => {
  let sessionToken: string | null = null;
  let unconsentedMessage: string | null = null;

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

  it('tells a fresh account its voice is not drawn from its own corpus yet', async () => {
    const readiness = await corpus.voiceReadiness();

    // Not merely "early". Nothing this account writes is sorted until it makes
    // the consent decision, so a signal that told it to keep writing would be
    // describing a road that does not exist.
    expect(readiness.state).toBe('not_consented');
    expect(readiness.ready).toBe(false);
    expect(readiness.classified_fragment_count).toBe(0);
    expect(readiness.grounding_source).toBe('recent_entries');
    expect(readiness.message).not.toBeNull();

    unconsentedMessage = readiness.message;
  });

  it('says nothing about writing more entries to an account that cannot benefit', async () => {
    // The sentence is the server's, and this is the assertion that keeps it
    // honest end to end: the copy an un-consented account reads must not name
    // an accelerator that does nothing for it.
    expect(unconsentedMessage).not.toBeNull();
    const lowered = (unconsentedMessage ?? '').toLowerCase();

    for (const accelerator of [
      'write a few more',
      'keep writing',
      'more entries',
      'write more',
      'as you write',
    ]) {
      expect(lowered).not.toContain(accelerator);
    }
  });

  it('moves to gathering the moment the account agrees, with nothing written yet', async () => {
    const granted = await corpusConsent.set(JOURNAL, true);
    expect(granted.granted).toBe(true);

    const after = await corpus.voiceReadiness();

    // The corpus is still empty and the account is still not ready. What
    // changed is which of the two honest sentences applies — the whole reason
    // readiness is three-state rather than a boolean.
    expect(after.state).toBe('gathering');
    expect(after.ready).toBe(false);
    expect(after.classified_fragment_count).toBe(0);
    expect(after.message).not.toBeNull();
    expect(after.message).not.toBe(unconsentedMessage);
  });

  it('goes back to the decision when the account withdraws', async () => {
    await corpusConsent.set(JOURNAL, false);

    const after = await corpus.voiceReadiness();

    // Consent is the standing decision, not "was anything ever sorted".
    expect(after.state).toBe('not_consented');
    expect(after.message).toBe(unconsentedMessage);
  });

  it('hands the same answer to a cold start on a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    expect((await corpus.voiceReadiness()).state).toBe('not_consented');
  });

  it('refuses to answer without a session at all', async () => {
    setTokenGetter(() => null);

    const failure = await rejection(corpus.voiceReadiness());

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);

    setTokenGetter(() => sessionToken);
  });

  it("never reports one account's corpus to another", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads the subject from the JWT alone, so the neighbour gets
    // their own untouched answer rather than anything the first account did.
    const readiness = await corpus.voiceReadiness();
    expect(readiness.state).toBe('not_consented');
    expect(readiness.classified_fragment_count).toBe(0);
  });
});
