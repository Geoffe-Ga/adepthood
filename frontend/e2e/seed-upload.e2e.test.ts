import { createHash } from 'node:crypto';

import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';

import { auth, corpus, setTokenGetter } from '@/api';
import type { DocumentImportT } from '@/api';

/**
 * Seeding a document into a vault you actually have, proven across the wire.
 *
 * This is the vault half of `POST /corpus/import`. Its sibling
 * (`corpus-import.e2e.test.ts`) drives the account that has no vault; this one
 * drives the account that has one, and until the lane grew a vault to point at,
 * that account could not exist. Every import in the lane took the local-fallback
 * path, so the only outcome a spec could have asserted was `vault_unavailable`
 * -- an answer that would have registered as coverage while proving the
 * journey's real outcome never happens.
 *
 * What is real here is everything: the production `@/api` client, the live
 * FastAPI server on ephemeral Postgres, `services.creek_vault_upload`,
 * adepthood's own `HttpCreekVaultClient` with its capability negotiation and
 * contract-version header, and a real socket to a process that answers Creek's
 * published `/v1` shapes. Nothing is mocked, patched or rebound; the only thing
 * standing in for Creek is Creek, which is an external product with its own
 * repository (see `e2e/README.md`, "the four external boundaries").
 *
 * **Two vacuity traps are closed deliberately.** The first test asserts the
 * upload was `accepted` with a ref before any other test asserts anything, so a
 * lane whose owner wiring silently failed goes red on the arrange rather than
 * passing every later assertion about a vault it never reached. And the privacy
 * test asserts what the vault *did* receive before asserting what it did not:
 * "nothing arrived" is satisfied just as well by a fake nobody ever dialled, and
 * that is exactly the shape of a proof that proves nothing.
 */

/** Where the fake records what arrived, and the fragments it holds. */
interface VaultLedger {
  received: Array<{
    method: string;
    path: string;
    externalId: string | null;
    tier: string | null;
    digest?: string | null;
    action?: string;
  }>;
  fragments: Array<{
    kind: 'journal' | 'upload' | 'voice-draft';
    externalId: string;
    fragmentId: string;
    digest: string;
    writes: number;
  }>;
}

/** Where a document goes for the one account that has connected a vault. */
const VAULT = 'vault';

/** The two upload outcomes this journey distinguishes, in the wire's own words. */
const ACCEPTED = 'accepted';
const CAPABILITY_UNSUPPORTED = 'capability_unsupported';

/** How the vault reported the second send of a document it already held. */
const UNCHANGED = 'unchanged';

const SEED_FILENAME = 'field-notes.md';
const SEED_TEXT = '# Field notes\n\nA paragraph worth keeping, and keeping once.';
const INTIMATE_FILENAME = 'diary.md';
const INTIMATE_TEXT = 'Only for me, and only ever here.';

const lane = readLaneState();

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The same fingerprint the vault records, computed independently by the spec.
 *
 * Over the base64, because that is the field that travels: a digest taken over
 * the decoded bytes would be a second encoding decision that could drift from
 * the one on the wire and quietly stop matching anything.
 */
function digestOf(text: string): string {
  return createHash('sha256').update(encode(text), 'utf8').digest('hex');
}

function importDocument(
  filename: string,
  text: string,
  classification: 'personal' | 'intimate' = 'personal',
): Promise<DocumentImportT> {
  return corpus.importDocument({ filename, contentBase64: encode(text), classification });
}

/** Ask the vault what it has been sent. Never a skip: an absent lane throws. */
async function vaultLedger(): Promise<VaultLedger> {
  if (lane === null) {
    throw new Error('the lane recorded no state, so there is no vault to interrogate');
  }
  const response = await fetch(`${lane.vaultUrl}/__lane/uploads`, {
    headers: { Authorization: `Bearer ${lane.vaultApiKey}` },
  });
  if (response.status !== 200) {
    throw new Error(`the lane's vault answered its own ledger with ${response.status}`);
  }
  return (await response.json()) as VaultLedger;
}

describe('seeding a document into a connected vault, against a live server', () => {
  let sessionToken: string | null = null;
  let firstRef: string | null = null;

  beforeAll(async () => {
    if (lane === null) throw new Error('globalSetup recorded no lane state');
    if (lane.vaultOwnerEmail === '') {
      throw new Error('globalSetup recorded no vault owner, so no account here reaches a vault');
    }
    const session = await auth.login({
      email: lane.vaultOwnerEmail,
      password: lane.vaultOwnerPassword,
    });
    sessionToken = session.token;
    setTokenGetter(() => sessionToken);
  });

  afterAll(() => {
    setTokenGetter(null);
  });

  it('forwards the document to the vault and comes back with a ref', async () => {
    // The arrange, asserted rather than assumed. If the owner binding did not
    // take, this is `destination: "corpus"` or `vault_status:
    // "vault_unavailable"`, and the whole file goes red here instead of quietly
    // proving things about a vault nothing ever reached.
    const result = await importDocument(SEED_FILENAME, SEED_TEXT);

    expect(result.destination).toBe(VAULT);
    expect(result.vault_status).toBe(ACCEPTED);
    expect(result.stored).toBe(true);
    expect(result.vault_ref ?? '').not.toBe('');
    expect(result.corpus_status ?? null).toBeNull();
    firstRef = result.vault_ref ?? null;
  });

  it('actually put the document in the vault, at the tier the request declared', async () => {
    // The other half of the same claim: a 202 the server composed proves the
    // route, and only the vault's own ledger proves the document arrived.
    const { received, fragments } = await vaultLedger();
    const uploads = received.filter((entry) => entry.path === '/v1/uploads');
    const uploadedFragments = fragments.filter((fragment) => fragment.kind === 'upload');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.digest).toBe(digestOf(SEED_TEXT));
    expect(uploads[0]?.tier).toBe('personal');
    expect(uploadedFragments).toHaveLength(1);
    expect(uploadedFragments[0]?.fragmentId).toBe(firstRef);
  });

  it('reports a re-send as one fragment edited in place, not a second one', async () => {
    // Idempotence is the vault's, keyed on the external id adepthood derives
    // from the uploader and the filename, so the same document sent twice
    // addresses one fragment. Both ends are asserted: the ref the caller is
    // handed does not move, and the vault says it wrote nothing.
    const result = await importDocument(SEED_FILENAME, SEED_TEXT);

    expect(result.vault_status).toBe(ACCEPTED);
    expect(result.vault_ref).toBe(firstRef);

    const { received, fragments } = await vaultLedger();
    const uploads = received.filter((entry) => entry.path === '/v1/uploads');
    const uploadedFragments = fragments.filter((fragment) => fragment.kind === 'upload');

    expect(uploads).toHaveLength(2);
    expect(uploads[1]?.externalId).toBe(uploads[0]?.externalId);
    expect(uploads[1]?.action).toBe(UNCHANGED);
    expect(uploadedFragments).toHaveLength(1);
    expect(uploadedFragments[0]?.writes).toBe(2);
  });

  it('withholds an Intimate document from the vault entirely', async () => {
    // The privacy floor, proven over a real socket rather than asserted about a
    // mock. Intimate has no spelling on Creek's wire, so adepthood refuses
    // before the vault is contacted at all -- not one byte, and not even the
    // capability probe that would precede one.
    const before = await vaultLedger();
    expect(before.received.length).toBeGreaterThan(0);

    const result = await importDocument(INTIMATE_FILENAME, INTIMATE_TEXT, 'intimate');

    expect(result.destination).toBe(VAULT);
    expect(result.vault_status).toBe(CAPABILITY_UNSUPPORTED);
    expect(result.stored).toBe(false);
    expect(result.vault_ref ?? null).toBeNull();

    const after = await vaultLedger();
    expect(after.received).toEqual(before.received);
    expect(after.fragments).toEqual(before.fragments);
    expect(after.received.map((entry) => entry.digest)).not.toContain(digestOf(INTIMATE_TEXT));
  });
});
