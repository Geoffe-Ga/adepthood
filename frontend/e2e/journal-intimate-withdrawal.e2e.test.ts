import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';

import { ApiError, auth, journal, resonance, setTokenGetter } from '@/api';

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

async function draftDeleteActions(externalId: string): Promise<Array<string | undefined>> {
  const { received } = await vaultLedger();
  return received
    .filter(
      (request) => request.method === 'DELETE' && request.path === `/v1/voice-drafts/${externalId}`,
    )
    .map((request) => request.action);
}

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const RETRYABLE_WITHDRAWAL = 'vault_withdrawal_pending';
/** How many draft DELETEs in a row the lane vault refuses after `fail-next-voice-draft-delete`. */
const VAULT_FAILING_DELETES = 3;
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

async function failNextVoiceDraftDelete(): Promise<void> {
  if (lane === null) throw new Error('globalSetup recorded no lane state');
  const response = await fetch(`${lane.vaultUrl}/__lane/fail-next-voice-draft-delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lane.vaultApiKey}` },
  });
  if (response.status !== HTTP_OK) {
    throw new Error(`the lane's vault refused its failure control with ${response.status}`);
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/**
 * Choosing Intimate for a page whose Voice Draft reached the vault (#3060, #3077).
 *
 * The tier is committed locally whatever Creek says. When the first Voice Draft
 * retraction fails at the real HTTP boundary, the PATCH must say so -- the
 * stable retryable 503 -- instead of answering 200 while the AI-authored draft
 * is still in the vault. Choosing Intimate again is the retry the privacy
 * control's copy promises: it re-sends the owed DELETE and succeeds once Creek
 * confirms both replicas absent.
 */
describe('Intimate reclassification withdraws every connected-vault copy', () => {
  let sessionToken: string | null = null;
  let entryId = 0;
  let voiceDraftExternalId = '';

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

  it('mirrors a Personal page and its generated Voice Draft', async () => {
    const before = new Set((await vaultLedger()).fragments.map((fragment) => fragment.externalId));
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    entryId = entry.id;
    await journal.update(entryId, { status: 'finished' });
    const pass = await resonance.generate(entryId);
    const note = required(pass.marginalia[0], 'marginalia');
    const expanded = await resonance.essay(note.id, { priceAcknowledged: true });
    expect((expanded.essay ?? '').trim()).not.toBe('');

    const draft = required(
      (await vaultLedger()).fragments.find(
        (fragment) => fragment.kind === 'voice-draft' && !before.has(fragment.externalId),
      ),
      'new Voice Draft fragment',
    );
    voiceDraftExternalId = draft.externalId;
  });

  it('keeps Intimate but reports pending when the draft retraction fails', async () => {
    await failNextVoiceDraftDelete();

    const failure = await rejection(journal.update(entryId, { classification: 'intimate' }));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect((failure as ApiError).detail).toBe(RETRYABLE_WITHDRAWAL);
    await expect(journal.get(entryId)).resolves.toMatchObject({
      id: entryId,
      classification: 'intimate',
    });
    const attempts = await draftDeleteActions(voiceDraftExternalId);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((action) => action === 'failed')).toBe(true);
    const { fragments } = await vaultLedger();
    expect(
      fragments.some(
        (fragment) =>
          fragment.kind === 'voice-draft' && fragment.externalId === voiceDraftExternalId,
      ),
    ).toBe(true);
  });

  it('each further choice of Intimate retries the owed DELETE while the vault stays down', async () => {
    // The lane vault refuses VAULT_FAILING_DELETES draft DELETEs in a row (sized
    // for the API client's idempotent DELETE retries). A PATCH is never retried
    // by the client, so each choice of Intimate is exactly one more attempt.
    for (let attempt = 2; attempt <= VAULT_FAILING_DELETES; attempt += 1) {
      const failure = await rejection(journal.update(entryId, { classification: 'intimate' }));

      expect((failure as ApiError).detail).toBe(RETRYABLE_WITHDRAWAL);
      expect(await draftDeleteActions(voiceDraftExternalId)).toEqual(
        Array.from({ length: attempt }, () => 'failed'),
      );
    }
  });

  it('choosing Intimate once the vault recovers confirms every replica absent', async () => {
    await expect(journal.update(entryId, { classification: 'intimate' })).resolves.toMatchObject({
      id: entryId,
      classification: 'intimate',
    });

    expect(await draftDeleteActions(voiceDraftExternalId)).toEqual([
      ...Array.from({ length: VAULT_FAILING_DELETES }, () => 'failed'),
      'deleted',
    ]);
    const { fragments } = await vaultLedger();
    expect(
      fragments.some(
        (fragment) =>
          fragment.kind === 'voice-draft' && fragment.externalId === voiceDraftExternalId,
      ),
    ).toBe(false);
    expect(
      fragments.some(
        (fragment) => fragment.kind === 'journal' && fragment.externalId === String(entryId),
      ),
    ).toBe(false);
  });

  it('is idempotent once confirmed: a further choice sends nothing', async () => {
    const before = (await draftDeleteActions(voiceDraftExternalId)).length;

    await expect(journal.update(entryId, { classification: 'intimate' })).resolves.toMatchObject({
      classification: 'intimate',
    });

    expect(await draftDeleteActions(voiceDraftExternalId)).toHaveLength(before);
  });
});
