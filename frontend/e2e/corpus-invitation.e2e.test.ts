import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, corpusInvitation, journal, resonance, setTokenGetter } from '@/api';

/**
 * Declining the corpus offer, proven across the wire (#2407).
 *
 * The owner ruling puts the corpus decision after the first COMPLETED
 * Resonance pass, lets a person set it aside with "Not now" or "Do not ask
 * again", and forbids it from coming back on the next press. Every half of
 * that is green on its own -- the note's tests mock the client, the router's
 * tests never see it, the settlement's counter is pinned in pytest -- so this
 * is the one place they agree on the paths, the verb, the shape of "never
 * asked", and the fact that the decline is the server's to remember rather
 * than the device's.
 *
 * The pass that opens the offer is real: the lane's provider is the stub, which
 * reads the page it is handed and quotes it back, so the pass resolves as a 200
 * that kept a note -- and a pass that keeps nothing is, by design, just as
 * completed. Either way it counts, which is the point here. What the lane
 * cannot drive is the note appearing beside the page; that moment is pinned by
 * the Jest specs beside JournalEntryScreen and tracked as its own journey.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
// One sale binds to one active account (ADR 0008, #1987), so the two accounts
// this journey registers need a key each -- a shared constant would see the
// second signup refused as an already-redeemed key.
const LICENSE_KEY = freshLicenseKey();
const NEIGHBOUR_LICENSE_KEY = freshLicenseKey();
const ENTRY_BODY = 'I walked by the river and the willow bent without breaking.';

const email = `e2e-invitation-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-invitation-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/** Write one entry and ask for its resonance, asserting the pass completed. */
async function completeAPass(): Promise<void> {
  const entry = await journal.create({ message: ENTRY_BODY });
  const pass = await resonance.generate(entry.id);
  // A pass the privacy floor withheld is not completed and would not count;
  // this entry is not intimate, so the server must not have withheld it.
  expect(pass.private).not.toBe(true);
}

describe('corpus-invitation journey against a live server', () => {
  let sessionToken: string | null = null;
  let dismissedAt: string | null = null;

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

  it('offers a fresh account nothing before it has asked for anything', async () => {
    const standing = await corpusInvitation.status();

    expect(standing).toEqual({ offer: false, dismissed_at: null, do_not_ask_again: false });
  });

  it('opens the offer once a first pass has completed', async () => {
    await completeAPass();

    const standing = await corpusInvitation.status();

    // The moment the ruling names, observed end to end: the settlement that
    // committed the pass is what counted it, and the read here is the same
    // read the note makes.
    expect(standing.offer).toBe(true);
    expect(standing.dismissed_at).toBeNull();
    expect(standing.do_not_ask_again).toBe(false);
  });

  it('records a plain "not now" and does not bring the offer back on the next pass', async () => {
    const declined = await corpusInvitation.dismiss(false);

    expect(declined.offer).toBe(false);
    expect(declined.dismissed_at).not.toBeNull();
    expect(declined.do_not_ask_again).toBe(false);
    dismissedAt = declined.dismissed_at;

    // The body's own failure mode: an invitation that reappears on every press.
    await completeAPass();
    const after = await corpusInvitation.status();
    expect(after.offer).toBe(false);
    expect(after.dismissed_at).toBe(dismissedAt);
  });

  it('keeps "do not ask again" through a later, softer decline', async () => {
    const final = await corpusInvitation.dismiss(true);
    expect(final.do_not_ask_again).toBe(true);

    const softened = await corpusInvitation.dismiss(false);

    expect(softened.do_not_ask_again).toBe(true);
    expect(softened.offer).toBe(false);
  });

  it('hands the same answer to a cold start on a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    const standing = await corpusInvitation.status();

    // Server-side, not device-side: a new session on a new device reads the
    // decision the person already made.
    expect(standing.do_not_ask_again).toBe(true);
    expect(standing.offer).toBe(false);
  });

  it('refuses to answer or record without a session at all', async () => {
    setTokenGetter(() => null);

    const read = await rejection(corpusInvitation.status());
    const write = await rejection(corpusInvitation.dismiss(true));

    expect(read).toBeInstanceOf(ApiError);
    expect((read as ApiError).status).toBe(401);
    expect(write).toBeInstanceOf(ApiError);
    expect((write as ApiError).status).toBe(401);

    setTokenGetter(() => sessionToken);
  });

  it("never carries one account's decision over to another", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: NEIGHBOUR_LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads the subject from the JWT alone: the neighbour is still
    // un-asked, and their own first pass opens their own offer.
    expect(await corpusInvitation.status()).toEqual({
      offer: false,
      dismissed_at: null,
      do_not_ask_again: false,
    });
    await completeAPass();
    expect((await corpusInvitation.status()).offer).toBe(true);
  });
});
