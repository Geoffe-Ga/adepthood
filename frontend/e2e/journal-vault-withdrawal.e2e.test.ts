import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';

import { ApiError, auth, journal, resonance, setTokenGetter } from '@/api';

/**
 * Withdrawing a journal page and its generated Voice Draft across real sockets.
 *
 * This journey logs in as the lane's pre-provisioned vault owner, so the live
 * FastAPI server resolves its production `HttpCreekVaultClient` and talks to the
 * isolated Creek contract process. The first Voice Draft DELETE is made to fail
 * at that external boundary. Adepthood must answer with its stable retryable
 * error and keep the page visible; only a later confirmed Voice Draft deletion
 * plus journal withdrawal may make the local page disappear.
 *
 * The fake records only identities, tiers, actions, and content digests. The
 * assertions can therefore prove both replicas existed and were removed without
 * bringing the writer's page or AI-authored draft back across a control route.
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
const HTTP_SERVICE_UNAVAILABLE = 503;
const RETRYABLE_WITHDRAWAL = 'vault_withdrawal_pending';
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

describe('journal withdrawal from a connected Creek vault', () => {
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

  it('stores both the page and its generated Voice Draft in the connected vault', async () => {
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    entryId = entry.id;
    await journal.update(entryId, { status: 'finished' });
    const pass = await resonance.generate(entryId);
    const note = required(pass.marginalia[0], 'marginalia');
    const expanded = await resonance.essay(note.id);

    expect((expanded.essay ?? '').trim()).not.toBe('');
    const { fragments } = await vaultLedger();
    expect(
      fragments.some(
        (fragment) => fragment.kind === 'journal' && fragment.externalId === String(entryId),
      ),
    ).toBe(true);
    const draft = required(
      fragments.find((fragment) => fragment.kind === 'voice-draft'),
      'Voice Draft fragment',
    );
    voiceDraftExternalId = draft.externalId;
  });

  it('keeps the page visible when Creek cannot confirm the Voice Draft deletion', async () => {
    await failNextVoiceDraftDelete();

    const failure = await rejection(journal.delete(entryId));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect((failure as ApiError).detail).toBe(RETRYABLE_WITHDRAWAL);
    await expect(journal.get(entryId)).resolves.toMatchObject({ id: entryId, message: PAGE });
    const { fragments } = await vaultLedger();
    expect(
      fragments.some(
        (fragment) =>
          fragment.kind === 'voice-draft' && fragment.externalId === voiceDraftExternalId,
      ),
    ).toBe(true);
  });

  it('removes every remote replica and the local page after a confirmed retry', async () => {
    await expect(journal.delete(entryId)).resolves.toBeUndefined();

    const { fragments, received } = await vaultLedger();
    expect(
      fragments.some(
        (fragment) => fragment.kind === 'journal' && fragment.externalId === String(entryId),
      ),
    ).toBe(false);
    expect(
      fragments.some(
        (fragment) =>
          fragment.kind === 'voice-draft' && fragment.externalId === voiceDraftExternalId,
      ),
    ).toBe(false);
    expect(
      received
        .filter(
          (request) =>
            request.method === 'DELETE' &&
            request.path === `/v1/voice-drafts/${voiceDraftExternalId}`,
        )
        .map((request) => request.action),
    ).toEqual(['failed', 'failed', 'failed', 'deleted']);

    const missing = await rejection(journal.get(entryId));
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(HTTP_NOT_FOUND);
  });
});
