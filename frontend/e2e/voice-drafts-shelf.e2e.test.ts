import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, journal, resonance, setTokenGetter, voiceDrafts } from '@/api';

/**
 * The Voice Drafts shelf, across the wire.
 *
 * `GET /journal/voice-drafts` shipped with no client at all, and the shelf is
 * the first thing that reaches it, so this is where the two halves meet. What
 * needs a live server is not the arithmetic — the router's own suite pins
 * ordering and the offset window — but the three facts neither half can see
 * alone: that a letter the writer asked for actually turns up on the shelf, on
 * the same envelope the client validates; that the shelf a fresh account opens
 * answers 200 with an empty page rather than an error, which is what the
 * screen's first-run state is built on; and that the shelf is scoped to its
 * reader, since the whole surface is one account's own prose.
 *
 * The expansion is generated rather than fixtured, because the shelf lists
 * exactly the rows the essay path wrote: a fixture would prove the listing
 * reads a table, not that the two routes agree about what an expanded note is.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const NEIGHBOUR_LICENSE_KEY = freshLicenseKey();
const UNAUTHORIZED = 401;

const PAGE =
  'The cedar held the rain all night. By morning I could hear each drop arrive and leave.';

const email = `e2e-voice-drafts-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-voice-drafts-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`the live journey returned no ${name}`);
  return value;
}

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('the Voice Drafts shelf against a live server', () => {
  let sessionToken: string | null = null;
  let entryId = 0;
  let marginaliaId = 0;
  let letter = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb the shelf', async () => {
    const session = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(session.user_id).toBeGreaterThan(0);
    sessionToken = session.token;
    setTokenGetter(() => sessionToken);
  });

  it('answers a shelf with nothing on it as an empty page, never as an error', async () => {
    // The screen's first-run state depends on this being a 200: an account that
    // has never expanded a note must be met by a sentence, not a failure.
    const empty = await voiceDrafts.list();

    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.has_more).toBe(false);
  });

  it('puts a letter on the shelf once a margin note is heard out at length', async () => {
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    entryId = entry.id;
    await journal.update(entryId, { status: 'finished' });

    const pass = await resonance.generate(entryId);
    const note = required(pass.marginalia[0], 'margin note');
    marginaliaId = note.id;
    const expanded = await resonance.essay(marginaliaId);
    letter = (expanded.essay ?? '').trim();
    expect(letter).not.toBe('');

    const shelf = await voiceDrafts.list();

    const draft = required(
      shelf.items.find((item) => item.marginalia_id === marginaliaId),
      'Voice Draft',
    );
    // The shelf must carry the letter itself, not a stub the screen would have
    // to go and fetch: the screen opens a draft with no further request.
    expect(draft.essay.trim()).toBe(letter);
    expect(draft.anchor_text).toBe(note.anchor_text);
    expect(draft.kind).toBe(note.kind);
    // And the note's own key, so a draft in hand can walk back to its page.
    expect(draft.journal_entry_id).toBe(entryId);
    expect(shelf.total).toBeGreaterThan(0);
    expect(shelf.has_more).toBe(false);
  });

  it('pages the shelf by the window the client asks for', async () => {
    const firstPage = await voiceDrafts.list({ limit: 1, offset: 0 });
    expect(firstPage.items).toHaveLength(1);

    // Past the end of a one-item shelf: an empty page and nothing more to ask
    // for, which is exactly what retires the screen's "Older letters" row.
    const beyond = await voiceDrafts.list({ limit: 1, offset: firstPage.total });
    expect(beyond.items).toEqual([]);
    expect(beyond.has_more).toBe(false);
  });

  it('hands the same shelf back to a cold start on a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    const shelf = await voiceDrafts.list();
    expect(shelf.items.some((item) => item.marginalia_id === marginaliaId)).toBe(true);
  });

  it('refuses to answer without a session at all', async () => {
    setTokenGetter(() => null);

    const failure = await rejection(voiceDrafts.list());

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(UNAUTHORIZED);

    setTokenGetter(() => sessionToken);
  });

  it("never shows one account's letters to another", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: NEIGHBOUR_LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads its subject from the JWT alone, and the shelf is one
    // account's own prose end to end — so the neighbour gets an empty shelf
    // rather than a stranger's letter.
    const shelf = await voiceDrafts.list();
    expect(shelf.items).toEqual([]);
    expect(shelf.total).toBe(0);
  });
});
