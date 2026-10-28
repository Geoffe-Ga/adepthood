import { describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

import { auth, journal, resetLlmApiKey, setLlmApiKeyGetter, setTokenGetter, vault } from '@/api';

/** Production journal client → live server → managed vault whose vendor refuses the key. */
const OWN_KEY = 'sk-ant-api03-lane3595rejectedKEYzzzzzzzz'; // pragma: allowlist secret
const HELPER = 'tests.e2e.keyed_classification';
const CLASSIFY = '/v1/classifications';
const FAILURE_CODE_MINOR = '0.26';
const HTTP_OK = 200;
const POLL_INTERVAL_MS = 100;
const SETTLE_MS = 15000;

interface Run {
  run_id: number;
  job_id: string | null;
  outcome: string;
  attempt_count: number;
  failure_code: string | null;
}

interface Ledger {
  received: Array<{ method: string; path: string; declared?: string | null }>;
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

async function failed(): Promise<Run> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const state = run('show');
    if (state.outcome === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('the refused classification never settled failed');
}

/**
 * #3595: the vendor refuses the writer's key. The lane vault then lists contract
 * 0.26, and the keyed pass it admitted ends failed -- naming request_key_rejected
 * only to a poll that declares 0.26, as Creek does. The live server polls at
 * 0.26 because the handshake listed it, lands the row failed with the code after
 * one admission (no re-submission), and the production vault client reads the
 * refusal back off GET /vault/connection, which is what Settings renders from.
 */
describe('a managed vault whose vendor refuses the writing request key', () => {
  it('ends the pass once, records why, and tells Settings', async () => {
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
      await control('reject-request-keys');
      setLlmApiKeyGetter(() => OWN_KEY);
      const before = await ledger();
      run('queue');
      arranged = true;
      const entry = await journal.create({
        message: 'The willow kept its roots through the storm.',
        classification: 'personal',
      });
      expect(entry.id).toBeGreaterThan(0);
      const admitted = run('show');
      expect(admitted.outcome).toBe('attempted');
      expect(admitted.job_id).toMatch(/^[a-f0-9-]{36}$/u);

      await control('release-pipeline-jobs');
      expect(await failed()).toMatchObject({
        run_id: admitted.run_id,
        attempt_count: 1,
        failure_code: 'request_key_rejected',
      });
      const calls = (await ledger()).received.slice(before.received.length);
      expect(calls.filter((call) => call.path === CLASSIFY)).toHaveLength(1);
      const polls = calls.filter((call) => call.path === `/v1/jobs/${admitted.job_id}`);
      expect(polls.length).toBeGreaterThan(0);
      expect(new Set(polls.map((call) => call.declared))).toEqual(new Set([FAILURE_CODE_MINOR]));
      expect((await vault.connection()).classification_key_rejected).toBe(true);
    } finally {
      setLlmApiKeyGetter(null);
      await control('release-pipeline-jobs');
      if (arranged) await failed();
      setTokenGetter(null);
      await control('accept-request-keys');
      await control('disable-pipeline');
      await control('withdraw-request-keys');
    }
  });
});
