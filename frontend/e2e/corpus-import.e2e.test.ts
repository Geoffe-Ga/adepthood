import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, corpus, corpusConsent, setTokenGetter } from '@/api';
import type { DocumentImportT } from '@/api';

/**
 * Importing a document when you have no vault, proven across the wire.
 *
 * Owner ruling on #3015: a corpus lives in a vault, so you can only have one if
 * you have a vault to keep it in. Since #3016 an account the server finds no
 * vault for is answered `vault_required` and nothing else happens -- the
 * document is not read, consent is not consulted, no provider is called and
 * nothing is stored. This spec is the one place the client and the server agree
 * on that across the wire: the path, the verb, the body, and the answer.
 *
 * **The accounts here have no vault, and that is the case under test.** The lane
 * does configure one -- `seed-upload.e2e.test.ts` needs somewhere to seed into
 * -- but `CREEK_VAULT_OWNER_USER_ID` binds it to a single pre-provisioned
 * account, and every account this spec creates is somebody else. The resolver
 * hands those the local fallback, so every import here reaches no vault.
 *
 * Each case below is a reason the retired local import used to answer
 * something else -- no consent yet, a format it could not read, the Intimate
 * tier, consent granted -- and each now gets the one answer, which is what
 * proves the document was never looked at.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const SECOND_LICENSE_KEY = freshLicenseKey();

/** The source the switch for documents is recorded under. */
const UPLOAD = 'upload';

/** The answer's vocabulary for an account that reaches no vault. */
const CORPUS = 'corpus';

/** The one answer such an account gets since #3016. */
const VAULT_REQUIRED = 'vault_required';

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

/** Everything the no-vault answer must say, and everything it must leave unset. */
function expectAskedForAVault(result: DocumentImportT): void {
  expect(result.destination).toBe(CORPUS);
  expect(result.corpus_status).toBe(VAULT_REQUIRED);
  expect(result.stored).toBe(false);
  expect(result.fragment_id ?? null).toBeNull();
  expect(result.vault_status ?? null).toBeNull();
  expect(result.vault_ref ?? null).toBeNull();
  expect(result.message.length).toBeGreaterThan(0);
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

  it('answers that the document needs a vault, and stores nothing', async () => {
    expectAskedForAVault(await importDocument('field-notes.md', '# Notes\n\nSomething I wrote.'));
  });

  it('never reads the document, so an unreadable format gets the same answer', async () => {
    // The retired local import refused a .pdf as format_unreadable. Getting the
    // vault answer instead is what proves nothing read the document.
    expectAskedForAVault(await importDocument('export.pdf', 'not really a pdf'));
  });

  it('stays the same answer once the switch for documents is on', async () => {
    // The switch is still offered and still recorded, but with no vault there
    // is nowhere for it to let a document in to.
    const state = await corpusConsent.set(UPLOAD, true);
    expect(state.granted).toBe(true);

    expectAskedForAVault(await importDocument('field-notes.md', 'A paragraph worth keeping.'));
  });

  it('gives an Intimate document the same answer, contacting nothing', async () => {
    expectAskedForAVault(await importDocument('diary.md', 'Only for me.', 'intimate'));
  });

  it('answers a neighbour who agreed to nothing the same way', async () => {
    // The route reads the subject from the JWT alone; consent is not consulted
    // on this answer, so a neighbour's undecided switch changes nothing.
    const neighbour = await auth.signup({
      email: `e2e-import-neighbour-${randomUUID()}${EMAIL_DOMAIN}`,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: SECOND_LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    expectAskedForAVault(await importDocument('field-notes.md', 'A neighbour writes too.'));
  });
});
