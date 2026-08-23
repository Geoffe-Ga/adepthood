import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, corpus, corpusConsent, setTokenGetter } from '@/api';
import type { DocumentImportT } from '@/api';

/**
 * Importing a document when you have no vault, proven across the wire.
 *
 * This is the journey the import route exists for. Until it shipped, a document
 * had exactly one destination, so an account that had never connected a vault
 * sent one and was told their vault had not answered — untrue of a vault they
 * never had — and their corpus stayed empty forever. Both halves stayed green
 * through that: the screen's tests build their own fixtures, and the router's
 * tests never see this client. This is the one place the two agree on the path,
 * the verb, the request body, and which of the two destinations answered.
 *
 * **The lane's accounts have no vault, and that is the case under test.** No
 * `CREEK_VAULT_*` configuration reaches the server, so the resolver hands back
 * the local fallback and every import here routes to the account's own corpus.
 * A spec that asserted a vault outcome would be asserting something this lane
 * cannot produce.
 *
 * What it does not assert is a stored fragment. Placing writing among the
 * frequencies costs a provider call and this lane has no provider, so a
 * consented import settles as `unclassified` here — the provider-free half of
 * the path, which is every part a person actually touches: where the document
 * went, whether they had agreed to it, and what the intimate tier does.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

/** The source an imported document carries, and the consent that gates it. */
const UPLOAD = 'upload';

/** Where a document goes for an account that has connected no vault. */
const CORPUS = 'corpus';

const email = `e2e-import-${randomUUID()}${EMAIL_DOMAIN}`;

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function importDocument(
  filename: string,
  text: string,
  classification: 'personal' | 'intimate' = 'personal',
): Promise<DocumentImportT> {
  return corpus.importDocument({ filename, contentBase64: encode(text), classification });
}

describe('importing a document without a vault, against a live server', () => {
  let sessionToken: string | null = null;

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

  it('routes the document to the corpus this account has, not to a vault it lacks', async () => {
    // The defect this closes, stated as an assertion: an account with no vault
    // must not be answered in the vault's vocabulary.
    const result = await importDocument('field-notes.md', '# Notes\n\nSomething I wrote.');

    expect(result.destination).toBe(CORPUS);
    expect(result.vault_status ?? null).toBeNull();
    expect(result.vault_ref ?? null).toBeNull();
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('stores nothing until this account has agreed to it', async () => {
    // Opt-in, read rather than assumed: the corpus is off until somebody turns
    // it on, so the first honest answer is the question, not a fragment.
    const result = await importDocument('field-notes.md', 'Something else I wrote.');

    expect(result.corpus_status).toBe('consent_required');
    expect(result.stored).toBe(false);
    expect(result.fragment_id ?? null).toBeNull();
  });

  it('decides a format it cannot read before it ever reaches the consent gate', async () => {
    // Free to decide and decided first: a format adepthood cannot open costs no
    // provider call and needs no permission, so it is refused on its own terms
    // rather than reported as a consent problem.
    const result = await importDocument('export.pdf', 'not really a pdf');

    expect(result.destination).toBe(CORPUS);
    expect(result.corpus_status).toBe('format_unreadable');
    expect(result.stored).toBe(false);
  });

  it('takes the document past the consent gate once the switch is on', async () => {
    const state = await corpusConsent.set(UPLOAD, true);
    expect(state.granted).toBe(true);

    const result = await importDocument('field-notes.md', 'A paragraph worth keeping.');

    expect(result.destination).toBe(CORPUS);
    // `stored` needs a classification, which needs a provider this lane has
    // not got; `unclassified` is that absence and is a real outcome of the
    // same path. What matters here is that consent is no longer the answer.
    expect(['stored', 'unclassified']).toContain(result.corpus_status);
  });

  it('refuses an Intimate document outright, whatever this account agreed to', async () => {
    // The asymmetry the corpus destination exists to express: placing writing
    // among the frequencies means reading it with a language model, and this
    // tier never goes to one. Consent does not unlock it.
    const result = await importDocument('diary.md', 'Only for me.', 'intimate');

    expect(result.corpus_status).toBe('tier_refused');
    expect(result.stored).toBe(false);
    expect(result.fragment_id ?? null).toBeNull();
  });

  it('leaves the decision with the account that made it', async () => {
    // The route reads the subject from the JWT alone, so a neighbour who has
    // agreed to nothing is still asked rather than swept along.
    const neighbour = await auth.signup({
      email: `e2e-import-neighbour-${randomUUID()}${EMAIL_DOMAIN}`,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    const result = await importDocument('field-notes.md', 'A neighbour writes too.');

    expect(result.destination).toBe(CORPUS);
    expect(result.corpus_status).toBe('consent_required');
  });
});
