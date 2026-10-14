import { expect } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { readLaneState, type LaneState } from './laneState';

import { ApiError, resonance } from '@/api';

/**
 * A vault-bound writer's first letter, refused across the wire (#3156, #3183).
 *
 * The lane's vault owner is vault-bound (#3061): every AI operation on their
 * writing must be answered by their vault or not at all. No vault advertises a
 * letter capability yet, so the essay route fails closed with the reflection
 * route's own 503 ``reflection_source_unavailable`` before the payer, price and
 * guardrail gates. The owner's decision is that the vault will write letters
 * (#3203); until it can, this is the honest behaviour, and the Voice Draft
 * mirror it used to feed is unreachable for a new letter.
 *
 * Shared by the two withdrawal journeys that log in as the vault owner, so both
 * prove the same four facts the same way:
 *
 * - the refusal is the 503 under its own token, never a 200 written elsewhere;
 * - nothing was charged, in the wallet *and* its audit trail (read out of band
 *   through ``tests.e2e.wallet_audit``, which tells "never charged" apart from
 *   "charged and refunded");
 * - no provider surface was dialled;
 * - no Voice Draft reached the vault: no ``/v1/voice-drafts`` request and no
 *   new ``voice-draft`` fragment in the fake's ledger.
 *
 * Asking twice also proves nothing was cached: a stored letter reopens free
 * with a 200, so a second identical refusal means ``essay`` is still empty.
 */

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const REFLECTION_SOURCE_UNAVAILABLE = 'reflection_source_unavailable';
const WALLET_MODULE = 'tests.e2e.wallet_audit';
const VOICE_DRAFT_PATH_PREFIX = '/v1/voice-drafts/';
/** The ask a writer makes for a letter: once, then again as a retry. */
const LETTER_ASKS = 2;

interface LedgerRequest {
  method: string;
  path: string;
}

interface LedgerFragment {
  kind: string;
  externalId: string;
}

interface Ledger {
  received: LedgerRequest[];
  fragments: LedgerFragment[];
}

/** Everything that could move if a letter were written or charged. */
interface Trace {
  wallet: unknown;
  providerAttempts: unknown;
  vault: Ledger;
}

function lane(): LaneState {
  const state = readLaneState();
  if (state === null) throw new Error('globalSetup recorded no lane state');
  return state;
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (response.status !== HTTP_OK) {
    throw new Error(`the lane answered ${url} with ${response.status}`);
  }
  return response.json();
}

async function trace(): Promise<Trace> {
  const { providerUrl, vaultUrl, vaultApiKey, vaultOwnerEmail } = lane();
  return {
    wallet: JSON.parse(runBackendModule(WALLET_MODULE, ['show', '--email', vaultOwnerEmail])),
    providerAttempts: await json(`${providerUrl}/__lane/attempts`),
    vault: (await json(`${vaultUrl}/__lane/uploads`, {
      Authorization: `Bearer ${vaultApiKey}`,
    })) as Ledger,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the letter to be refused, but it was written');
}

/**
 * Ask for the vault owner's first letter on ``marginaliaId`` and prove it is
 * refused without a charge, a dial, a cached letter or a Voice Draft.
 */
export async function expectVaultBoundLetterRefused(marginaliaId: number): Promise<void> {
  const before = await trace();

  for (let ask = 1; ask <= LETTER_ASKS; ask += 1) {
    // The explicit, priced ask the essay modal sends (#623): the refusal is
    // about the boundary, not a missing price acknowledgement.
    const refused = await rejection(resonance.essay(marginaliaId, { priceAcknowledged: true }));
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect((refused as ApiError).detail).toBe(REFLECTION_SOURCE_UNAVAILABLE);
  }

  const after = await trace();
  expect(after.wallet).toEqual(before.wallet);
  expect(after.providerAttempts).toEqual(before.providerAttempts);
  const newRequests = after.vault.received.slice(before.vault.received.length);
  expect(newRequests.filter((call) => call.path.startsWith(VOICE_DRAFT_PATH_PREFIX))).toEqual([]);
  const draftsBefore = new Set(
    before.vault.fragments
      .filter((fragment) => fragment.kind === 'voice-draft')
      .map((fragment) => fragment.externalId),
  );
  expect(
    after.vault.fragments.filter(
      (fragment) => fragment.kind === 'voice-draft' && !draftsBefore.has(fragment.externalId),
    ),
  ).toEqual([]);
}
