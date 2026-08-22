import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, journal, setTokenGetter } from '@/api';

/**
 * Unwriting one page, across the wire.
 *
 * Both halves have been covered on their own side for a long time and were
 * never joined: the route has backend tests for its soft delete, the client
 * ships a typed `journal.delete`, and until now nothing in the app called it.
 * A suite can be entirely green about a delete that no person can reach, which
 * is exactly what happened here, so the part that matters is proven at the
 * seam — that the id the shelf sends is the id the server removes, that the
 * entry stops being readable afterwards, and that the removal is owner-scoped
 * by the server rather than by anything the client chooses to send.
 *
 * The cross-account attempt runs before the owner's own delete, against a live
 * entry, so a refusal that quietly deleted something would be caught by the
 * read that follows it rather than hidden behind an already-empty journal.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_NOT_FOUND = 404;

const email = `e2e-journal-delete-${randomUUID()}${EMAIL_DOMAIN}`;
const somebodyElse = `e2e-not-my-page-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII on purpose: the entry has to survive the refused attempt intact.
const body = `Una página que quiero deshacer 灯 — ${randomUUID()}`;
const keptBody = `The page I am keeping 燈 — ${randomUUID()}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('journal-delete journey against a live server', () => {
  let sessionToken: string | null = null;
  let entryId = 0;
  let keptId = 0;

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

  it('writes two pages, one to delete and one that must survive it', async () => {
    entryId = (await journal.create({ message: body })).id;
    keptId = (await journal.create({ message: keptBody })).id;

    expect(entryId).toBeGreaterThan(0);
    expect(keptId).not.toBe(entryId);
    expect((await journal.list()).total).toBe(2);
  });

  it('refuses another account the delete, and leaves the page word for word', async () => {
    const theirs = await auth.signup({
      email: somebodyElse,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    const mine = sessionToken;
    sessionToken = theirs.token;

    const failure = await rejection(journal.delete(entryId));

    // Collapsed to 404, not 403: the server will not confirm the id exists.
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_NOT_FOUND);
    expect((failure as ApiError).detail).toBe('journal_entry_not_found');

    sessionToken = mine;
    // The refusal touched nothing: still readable by its owner, unchanged.
    expect(await journal.get(entryId)).toMatchObject({ id: entryId, message: body });
  });

  it('deletes the page its owner asked for, and only that one', async () => {
    await expect(journal.delete(entryId)).resolves.toBeUndefined();

    const page = await journal.list();
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([keptId]);
    expect(JSON.stringify(page.items)).not.toContain(body);
  });

  it('stops serving the deleted page to the account that wrote it', async () => {
    const failure = await rejection(journal.get(entryId));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_NOT_FOUND);
  });

  it('treats a repeated delete of the same page as a page that is not there', async () => {
    const failure = await rejection(journal.delete(entryId));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_NOT_FOUND);
  });
});
