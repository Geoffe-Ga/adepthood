import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';

import {
  auth,
  corpus,
  corpusConsent,
  journal,
  setTokenGetter,
  type CorpusSweepEstimate,
} from '@/api';

/**
 * A vault-bound writer sorts the writing their vault does not have (#3663).
 *
 * For a writer whose vault answers for their writing, "unsorted" means an
 * entry the vault never received -- one saved while it could not take writing
 * -- and one press of Sort hands every such entry to the vault in a background
 * run (#3665, #3671, #3678). Backend suites pin that over HTTP against a vault
 * double; this proves it across the real seam: the production client and its
 * Zod validation, the live server on Postgres, and the lane's Creek contract
 * fake, whose ledger records what actually arrived.
 *
 * The lane's vault owner is pre-provisioned and vault-bound, and shared with
 * other journeys, so everything this spec changes on it -- the ingest refusal
 * and the journal corpus grant -- is put back in `afterAll`.
 */

const lane = readLaneState();

const HTTP_OK = 200;
const JOURNAL = 'journal';
const SETTLE_MS = 15000;
const POLL_INTERVAL_MS = 100;

/** Two entries the vault may receive, and one it never may. */
const SORTABLE = [
  'The kettle ticked as it cooled, and I let it.',
  'Wrote by the window until the light went orange.',
];
const INTIMATE = 'Only for me, and not for any vault.';

interface LedgerRequest {
  method: string;
  path: string;
  externalId: string | null;
  action?: string;
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`the journey has no ${name}`);
  return value;
}

/** Flip one of the lane vault's switches. */
async function control(name: 'refuse-journal-ingest' | 'accept-journal-ingest'): Promise<void> {
  const state = required(lane, 'lane state');
  const response = await fetch(`${state.vaultUrl}/__lane/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.vaultApiKey}` },
  });
  expect(response.status).toBe(HTTP_OK);
}

/** Every request the lane vault has received, oldest first. */
async function received(): Promise<LedgerRequest[]> {
  const state = required(lane, 'lane state');
  const response = await fetch(`${state.vaultUrl}/__lane/uploads`, {
    headers: { Authorization: `Bearer ${state.vaultApiKey}` },
  });
  expect(response.status).toBe(HTTP_OK);
  return ((await response.json()) as { received: LedgerRequest[] }).received;
}

/** The journal PUTs the vault stored (not refused) for ``ids``. */
async function storedPuts(ids: readonly number[]): Promise<LedgerRequest[]> {
  const wanted = new Set(ids.map(String));
  return (await received()).filter(
    (request) =>
      request.method === 'PUT' &&
      request.path.startsWith('/v1/journal-entries/') &&
      request.externalId !== null &&
      wanted.has(request.externalId) &&
      request.action !== 'refused',
  );
}

/** Read until the latest run is no longer running, as the screen does. */
async function settled(): Promise<CorpusSweepEstimate> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const estimate = await corpus.sweepEstimate();
    if (estimate.run?.state !== 'running') return estimate;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('the background sort never finished');
}

describe('a vault-bound writer sorts the writing their vault does not have', () => {
  let sessionToken: string | null = null;
  let grantedBefore = false;
  const sortable: number[] = [];
  let intimate = 0;

  beforeAll(async () => {
    const state = required(lane, 'lane state');
    const session = await auth.login({
      email: state.vaultOwnerEmail,
      password: state.vaultOwnerPassword,
    });
    sessionToken = session.token;
    setTokenGetter(() => sessionToken);
    grantedBefore = (await corpusConsent.list()).some(
      (decision) => decision.source === JOURNAL && decision.granted,
    );
  });

  afterAll(async () => {
    try {
      await control('accept-journal-ingest');
      if (!grantedBefore) await corpusConsent.set(JOURNAL, false);
    } finally {
      setTokenGetter(null);
    }
  });

  it('saves pages while the vault refuses them, so they wait to be sorted', async () => {
    await corpusConsent.set(JOURNAL, true);
    await control('refuse-journal-ingest');
    try {
      for (const message of SORTABLE) {
        sortable.push(required((await journal.create({ message })).id, 'entry id'));
      }
      intimate = required(
        (await journal.create({ message: INTIMATE, classification: 'intimate' })).id,
        'intimate entry id',
      );
    } finally {
      await control('accept-journal-ingest');
    }

    expect(await storedPuts(sortable)).toEqual([]);
    expect((await corpus.sweepEstimate()).entries_pending).toBeGreaterThanOrEqual(SORTABLE.length);
  });

  it('one press hands the vault every page it lacks, and never the Intimate one', async () => {
    const press = await corpus.sweep();
    const after = await settled();

    expect(press.run?.lane).toBe('vault_bound');
    expect(after.run?.id).toBe(press.run?.id);
    expect(after.run?.state).toBe('completed');
    expect(after.entries_pending).toBe(0);
    const stored = await storedPuts(sortable);
    expect(new Set(stored.map((request) => request.externalId))).toEqual(
      new Set(sortable.map(String)),
    );
    expect(await storedPuts([intimate])).toEqual([]);
  });

  it('a second press sends nothing new, because the vault already has it all', async () => {
    const before = (await storedPuts(sortable)).length;

    await corpus.sweep();
    const after = await settled();

    expect(after.run?.state).toBe('completed');
    expect(after.run?.entries_sorted).toBe(0);
    expect(after.entries_pending).toBe(0);
    expect(await storedPuts(sortable)).toHaveLength(before);
  });
});
