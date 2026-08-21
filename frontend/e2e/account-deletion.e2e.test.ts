import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, journal, setTokenGetter, users } from '@/api';

/**
 * Ending an account from inside the app, across the wire.
 *
 * Both halves of this feature are covered on their own side: the screen's tests
 * mock `users.deleteMyAccount`, and the route's tests drive the sweep from
 * `SQLModel.metadata`. Neither can see a disagreement between them -- a renamed
 * `confirm_email`, a changed verb, a moved path -- and the failure that
 * disagreement produces is a shipped app whose only in-app erasure path is
 * broken, which App Store Guideline 5.1.1(v) makes a release blocker.
 *
 * The confirmation gate is the part only a seam test can prove, so it is
 * exercised first, against real data that must survive the refusal.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

/** The account's own row plus the journal entry it wrote. */
const MINIMUM_ROWS_ERASED = 2;

const email = `e2e-account-deletion-${randomUUID()}${EMAIL_DOMAIN}`;
const somebodyElse = `e2e-not-me-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII on purpose: the entry has to survive the refused attempt intact.
const body = `Lo que quiero que desaparezca 灯 — ${randomUUID()}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('account-deletion journey against a live server', () => {
  let sessionToken: string | null = null;
  let entryId = 0;

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

  it('writes something worth erasing and reads it back', async () => {
    const created = await journal.create({ message: body });

    expect(created.message).toBe(body);

    entryId = created.id;
    expect(await journal.get(entryId)).toMatchObject({ id: entryId, message: body });
  });

  it("refuses somebody else's address as confirmation, and erases nothing", async () => {
    const failure = await rejection(users.deleteMyAccount({ confirm_email: somebodyElse }));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as ApiError).detail).toBe('confirmation_email_mismatch');
    // The refusal touched nothing: the entry is still readable, word for word.
    expect(await journal.get(entryId)).toMatchObject({ id: entryId, message: body });
  });

  it('erases the account on the retyped address and hands back a receipt', async () => {
    // Deliberately not the stored casing: a user whose keyboard capitalised the
    // first letter typed their own address, and the server says so.
    const receipt = await users.deleteMyAccount({ confirm_email: email.toUpperCase() });

    expect(receipt.recoverable).toBe(false);
    expect(receipt.rows_erased).toBeGreaterThanOrEqual(MINIMUM_ROWS_ERASED);
    // Shape, not counts: the policy test owns completeness, and counts move
    // whenever a model is added. What matters here is that the two tables this
    // journey actually filled are named as erased.
    expect(receipt.erased).toContain('user');
    expect(receipt.erased).toContain('journalentry');
    expect(Array.isArray(receipt.anonymised)).toBe(true);
    // The receipt of the erasure survives the erasure -- counts only, no
    // content -- or nothing is left to show that it happened.
    expect(receipt.retained).toContain('accountdeletionaudit');
    expect(receipt.erased).not.toContain('accountdeletionaudit');
    // Adepthood has no purge verb on the vault contract, so it may never claim
    // one -- and it has to say what is left for the user to do themselves.
    expect(receipt.vault.purged).toBe(false);
    expect(receipt.vault.guidance.length).toBeGreaterThan(0);
  });

  it('kills the session it was holding, so the token cannot outlive the account', async () => {
    const failure = await rejection(journal.list());

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
  });

  it('refuses to log the erased account back in', async () => {
    const failure = await rejection(auth.login({ email, password: PASSWORD }));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
    expect((failure as ApiError).detail).toBe('invalid_credentials');
  });

  it('frees the address for a new account that inherits nothing', async () => {
    const fresh = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = fresh.token;

    // Erasure, not deactivation: the address is registrable again, and what the
    // previous account wrote is not waiting for whoever registers it.
    expect(await journal.list()).toEqual({ items: [], total: 0, has_more: false });
  });
});
