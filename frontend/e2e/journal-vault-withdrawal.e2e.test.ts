import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';
import { expectVaultBoundLetterRefused } from './vaultBoundLetter';

import { ApiError, auth, journal, resonance, setTokenGetter } from '@/api';

/**
 * Withdrawing a journal page from a connected Creek vault across real sockets.
 *
 * This journey logs in as the lane's pre-provisioned vault owner, so the live
 * FastAPI server resolves its production `HttpCreekVaultClient` and talks to the
 * isolated Creek contract process. The page reaches the vault, the owner's
 * resonance pass is answered by that vault (#3061), and deleting the page
 * withdraws the vault's replica before the local page disappears.
 *
 * The owner is vault-bound, so a first letter on the vault's margin note is
 * refused 503 `reflection_source_unavailable` -- uncharged, undialled, and with
 * no Voice Draft reaching the vault (#3156). The Voice Draft half of this
 * journey (a failed draft retraction keeping the page visible, then a confirmed
 * retry) returns once the vault writes letters itself (#3203).
 *
 * The fake records only identities, tiers, actions, and content digests. The
 * assertions can therefore prove the replica existed and was removed without
 * bringing the writer's page back across a control route.
 */

interface VaultFragment {
  kind: 'journal' | 'upload' | 'voice-draft';
  externalId: string;
  fragmentId: string;
  digest: string;
  writes: number;
}

interface VaultLedger {
  received: Array<{
    method: string;
    path: string;
    externalId: string | null;
    action?: string;
  }>;
  fragments: VaultFragment[];
}

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const PAGE =
  'The cedar held the rain all night. By morning I could hear each drop arrive and leave.';

/** What `fakeCreekVault.mjs` answers every reflection with, quoting the page's first sentence. */
const LANE_VAULT_NOTE = 'The lane vault reads this line back to you.';
const PAGE_FIRST_SENTENCE = 'The cedar held the rain all night';

const lane = readLaneState();

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`the live journey returned no ${name}`);
  return value;
}

async function vaultLedger(): Promise<VaultLedger> {
  if (lane === null) throw new Error('globalSetup recorded no lane state');
  const response = await fetch(`${lane.vaultUrl}/__lane/uploads`, {
    headers: { Authorization: `Bearer ${lane.vaultApiKey}` },
  });
  if (response.status !== HTTP_OK) {
    throw new Error(`the lane's vault answered its ledger with ${response.status}`);
  }
  return (await response.json()) as VaultLedger;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

function holdsPage(fragments: VaultFragment[], entryId: number): boolean {
  return fragments.some(
    (fragment) => fragment.kind === 'journal' && fragment.externalId === String(entryId),
  );
}

describe('journal withdrawal from a connected Creek vault', () => {
  let sessionToken: string | null = null;
  let entryId = 0;
  let marginaliaId = 0;

  beforeAll(async () => {
    if (lane === null) throw new Error('globalSetup recorded no lane state');
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

  it('stores the page in the connected vault and has the vault answer its resonance', async () => {
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    entryId = entry.id;
    await journal.update(entryId, { status: 'finished' });
    const pass = await resonance.generate(entryId);
    const note = required(pass.marginalia[0], 'marginalia');
    marginaliaId = note.id;

    const { fragments, received } = await vaultLedger();
    // The owner is vault-bound (#3061): the note is the vault's own answer,
    // quoting the page, and never an app-provider substitute.
    expect(note.note).toBe(LANE_VAULT_NOTE);
    expect(note.anchor_text).toBe(PAGE_FIRST_SENTENCE);
    expect(received.some((call) => call.method === 'POST' && call.path === '/v1/reflections')).toBe(
      true,
    );
    expect(holdsPage(fragments, entryId)).toBe(true);
  });

  it('refuses the first letter uncharged, so no Voice Draft reaches the vault', async () => {
    await expectVaultBoundLetterRefused(marginaliaId);
  });

  it('removes the remote replica and then the local page on delete', async () => {
    await expect(journal.delete(entryId)).resolves.toBeUndefined();

    const { fragments, received } = await vaultLedger();
    expect(holdsPage(fragments, entryId)).toBe(false);
    expect(
      received.some(
        (request) =>
          request.method === 'DELETE' && request.path === `/v1/journal-entries/${entryId}`,
      ),
    ).toBe(true);

    const missing = await rejection(journal.get(entryId));
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(HTTP_NOT_FOUND);
  });
});
