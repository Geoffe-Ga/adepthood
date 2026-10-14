import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';
import { expectVaultBoundLetterRefused } from './vaultBoundLetter';

import { auth, journal, resonance, setTokenGetter } from '@/api';

/**
 * Withdrawing every connected-vault copy when a page becomes Intimate.
 *
 * Like journal-vault-withdrawal.e2e.test.ts, this logs in as the lane's
 * pre-provisioned vault owner so the live server uses its production
 * `HttpCreekVaultClient` against the out-of-process Creek contract fake, whose
 * ledger records only opaque ids, tiers, actions, and digests.
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
const PAGE =
  'The cedar held the rain all night. By morning I could hear each drop arrive and leave.';

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

async function pageWithdrawals(entryId: number): Promise<number> {
  const { received } = await vaultLedger();
  return received.filter(
    (request) => request.method === 'DELETE' && request.path === `/v1/journal-entries/${entryId}`,
  ).length;
}

function holdsPage(fragments: VaultFragment[], entryId: number): boolean {
  return fragments.some(
    (fragment) => fragment.kind === 'journal' && fragment.externalId === String(entryId),
  );
}

/**
 * Choosing Intimate for a page whose replica reached the vault (#3060, #3077).
 *
 * The tier is committed locally and the vault's journal replica is withdrawn.
 * The owner is vault-bound (#3061), so the letter that once became a Voice
 * Draft in the vault is refused 503 `reflection_source_unavailable` before any
 * charge (#3156): there is no draft to retract. The draft-retraction half of
 * this journey -- a failed DELETE answered with the retryable 503
 * `vault_withdrawal_pending`, then retried until the vault confirms both
 * replicas absent -- returns once the vault writes letters itself (#3203).
 */
describe('Intimate reclassification withdraws every connected-vault copy', () => {
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

  it('mirrors a Personal page and has the vault answer its resonance', async () => {
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    entryId = entry.id;
    await journal.update(entryId, { status: 'finished' });
    const pass = await resonance.generate(entryId);
    marginaliaId = required(pass.marginalia[0], 'marginalia').id;

    expect(holdsPage((await vaultLedger()).fragments, entryId)).toBe(true);
  });

  it('refuses the first letter uncharged, so no Voice Draft reaches the vault', async () => {
    await expectVaultBoundLetterRefused(marginaliaId);
  });

  it('choosing Intimate commits the tier and confirms the page replica absent', async () => {
    await expect(journal.update(entryId, { classification: 'intimate' })).resolves.toMatchObject({
      id: entryId,
      classification: 'intimate',
    });

    await expect(journal.get(entryId)).resolves.toMatchObject({
      id: entryId,
      classification: 'intimate',
    });
    expect(await pageWithdrawals(entryId)).toBeGreaterThan(0);
    expect(holdsPage((await vaultLedger()).fragments, entryId)).toBe(false);
  });

  it('is idempotent once confirmed: a further choice sends nothing', async () => {
    const before = await pageWithdrawals(entryId);

    await expect(journal.update(entryId, { classification: 'intimate' })).resolves.toMatchObject({
      classification: 'intimate',
    });

    expect(await pageWithdrawals(entryId)).toBe(before);
  });
});
