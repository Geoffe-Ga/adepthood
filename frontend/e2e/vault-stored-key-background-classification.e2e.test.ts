import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

import {
  auth,
  journal,
  resetLlmApiKey,
  setLlmApiKeyGetter,
  setTokenGetter,
  vaultClassificationKey,
  vaultRequestKeys,
} from '@/api';

/** Synthetic and well-formed; the lane vault never calls a vendor, so it is never spent. */
const OWN_KEY = 'sk-ant-api03-lane3647storedKEYcanaryzzzzz'; // pragma: allowlist secret
const OWN_KEY_DIGEST = createHash('sha256').update(OWN_KEY, 'utf8').digest('hex');
const HELPER = 'tests.e2e.keyed_classification';
const CLASSIFY = '/v1/classifications';
const HTTP_OK = 200;
const POLL_INTERVAL_MS = 100;
/** The detached retry backs off a second before it re-submits; leave room for a loaded lane. */
const SETTLE_MS = 30000;
/** The shed admission, then the one detached retry that is admitted. */
const ADMISSIONS_PER_PASS = 2;
const KEYED_SUBMIT = {
  method: 'POST',
  path: CLASSIFY,
  provider: 'anthropic',
  keyDigest: OWN_KEY_DIGEST,
};

interface Run {
  run_id: number;
  job_id: string | null;
  outcome: string;
  attempt_count: number;
  stored_key_vendor: string | null;
  stored_key_sealed: boolean | null;
}

interface Submit {
  method: string;
  path: string;
  refused?: boolean;
}

interface Ledger {
  received: Submit[];
  keyed: Array<{ method: string; path: string; provider: string; keyDigest: string }>;
}

/** What one pass put on the vault's ledger: its classification submits, and the keys they carried. */
interface Pass {
  run: Run;
  submits: Submit[];
  keyed: Ledger['keyed'];
}

function lane() {
  const state = readLaneState();
  if (state === null) throw new Error('globalSetup recorded no lane state');
  return state;
}

async function control(name: string): Promise<void> {
  const response = await fetch(`${lane().vaultUrl}/__lane/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lane().vaultApiKey}` },
  });
  expect(response.status).toBe(HTTP_OK);
}

async function ledger(): Promise<Ledger> {
  const response = await fetch(`${lane().vaultUrl}/__lane/uploads`, {
    headers: { Authorization: `Bearer ${lane().vaultApiKey}` },
  });
  expect(response.status).toBe(HTTP_OK);
  return (await response.json()) as Ledger;
}

function run(command: 'queue' | 'show'): Run {
  return JSON.parse(runBackendModule(HELPER, [command, '--email', lane().vaultOwnerEmail])) as Run;
}

async function until(done: (state: Run) => boolean, what: string): Promise<Run> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const state = run('show');
    if (done(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`the classification never ${what}`);
}

/**
 * Save one page while the vault sheds the classification it would admit, then
 * wait for adepthood's detached retry to land it.
 *
 * The request answers first: `journal.create` has resolved before anything is
 * awaited here. The retry is the continuation's own -- `attempt_count` 2 is
 * written only by its bounded retry, on a task started in a keyless context --
 * so whatever key that submit carries came from nowhere but the server's
 * stored copy.
 */
async function saveThroughShedAdmission(message: string): Promise<Pass> {
  const before = await ledger();
  const queued = run('queue');
  await control('refuse-next-classification');
  const entry = await journal.create({ message, classification: 'personal' });
  expect(entry.id).toBeGreaterThan(0);
  const landed = await until((state) => state.outcome === 'completed', 'completed');
  expect(landed).toMatchObject({ run_id: queued.run_id, attempt_count: ADMISSIONS_PER_PASS });
  const after = await ledger();
  const submits = after.received
    .slice(before.received.length)
    .filter((call) => call.method === 'POST' && call.path === CLASSIFY);
  // Exactly the shed admission, then the retry the vault admitted.
  expect(submits.map((call) => call.refused === true)).toEqual([true, false]);
  return { run: landed, submits, keyed: after.keyed.slice(before.keyed.length) };
}

/**
 * #3647 (R1-1, ADR 0009 amendment 2026-11-01): an un-enrolled writer's keyed
 * classification admission leaves their key encrypted on the server, and the
 * classification that runs after their request has ended relays that stored
 * copy -- until they take the key back.
 *
 * Production client → live server (at-rest encryption on, as every deployment
 * runs) → lane vault advertising `request_key_providers`. Nothing in the server
 * is stubbed: the vault sheds one admission with Creek's own `503
 * temporarily_unavailable`, and adepthood's bounded retry re-submits it off the
 * request. The vault's ledger records each submit's key by SHA-256 digest only.
 */
describe('a managed vault classifies in the background with the stored key', () => {
  it('relays the stored key on a detached retry, and none once the writer removes it', async () => {
    resetLlmApiKey();
    const session = await auth.login({
      email: lane().vaultOwnerEmail,
      password: lane().vaultOwnerPassword,
    });
    setTokenGetter(() => session.token);
    let arranged = false;
    try {
      await control('advertise-request-keys');
      await control('enable-pipeline');
      await control('release-pipeline-jobs');
      // Start from no stored copy, whatever an earlier journey left behind.
      await vaultClassificationKey.forget();
      expect(run('show').stored_key_vendor).toBeNull();
      setLlmApiKeyGetter(() => OWN_KEY);
      expect(await vaultRequestKeys.get()).toContain('anthropic');

      // 1. The writer's request carries their key. Its own admission is shed;
      //    the detached retry that follows the reply carries the same key.
      arranged = true;
      const keyedSave = await saveThroughShedAdmission(
        'The willow bent all night and did not break.',
      );
      expect(keyedSave.keyed).toEqual([KEYED_SUBMIT, KEYED_SUBMIT]);
      expect(keyedSave.run).toMatchObject({
        stored_key_vendor: 'anthropic',
        stored_key_sealed: true,
      });

      // 2. A device that sends no key: no request in this pass ever held one,
      //    so the digest on both background submits is the stored copy's.
      setLlmApiKeyGetter(null);
      const keylessSave = await saveThroughShedAdmission('By morning the river had gone quiet.');
      expect(keylessSave.keyed).toEqual([KEYED_SUBMIT, KEYED_SUBMIT]);

      // 3. The writer takes the key back. The same keyless pass now relays nothing.
      await vaultClassificationKey.forget();
      expect(run('show')).toMatchObject({ stored_key_vendor: null, stored_key_sealed: null });
      const afterRemoval = await saveThroughShedAdmission('The heron stood in the shallows.');
      expect(afterRemoval.submits).toHaveLength(ADMISSIONS_PER_PASS);
      expect(afterRemoval.keyed).toEqual([]);
    } finally {
      setLlmApiKeyGetter(null);
      if (arranged) {
        await until((state) => !['queued', 'attempted'].includes(state.outcome), 'drained');
      }
      await vaultClassificationKey.forget();
      setTokenGetter(null);
      await control('disable-pipeline');
      await control('withdraw-request-keys');
    }
  });
});
