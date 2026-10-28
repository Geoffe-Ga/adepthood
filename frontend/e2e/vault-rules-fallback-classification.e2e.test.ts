import { describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

import { auth, journal, resetLlmApiKey, setLlmApiKeyGetter, setTokenGetter, vault } from '@/api';

/** Production journal client → live server → managed vault that answers with its rules floor. */
const OWN_KEY = 'sk-ant-api03-lane3577rulesfloorKEYzzzzzz'; // pragma: allowlist secret
const HELPER = 'tests.e2e.keyed_classification';
const CLASSIFY = '/v1/classifications';
const HTTP_OK = 200;
const POLL_INTERVAL_MS = 100;
const SETTLE_MS = 15000;
/** The server's sentence, word for word: the client renders it and writes none of its own. */
const ROUGH_SORT =
  'Some of your writing has only had a rough sort so far. A fuller sort has not finished yet. ' +
  'Nothing is waiting on you.';

interface Run {
  run_id: number;
  job_id: string | null;
  outcome: string;
  attempt_count: number;
}

interface Ledger {
  received: Array<{ method: string; path: string }>;
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

async function landed(outcome: 'completed' | 'incomplete'): Promise<Run> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const state = run('show');
    if (state.outcome === outcome) return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`the classification never landed ${outcome}`);
}

/** Wait until no classification is in flight, whichever way it landed. */
async function drained(): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    if (!['queued', 'attempted'].includes(run('show').outcome)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('the classification never drained');
}

/** Save one page and let the vault answer the classification it admits. */
async function classifyOnePage(message: string): Promise<Run> {
  run('queue');
  const entry = await journal.create({ message, classification: 'personal' });
  expect(entry.id).toBeGreaterThan(0);
  const admitted = run('show');
  expect(admitted.outcome).toBe('attempted');
  await control('release-pipeline-jobs');
  return admitted;
}

/**
 * #3577: Creek's managed rules floor finishes a requested `llm` pass with
 * `method: 'rules'`, `complete: true`. The live server lands that row
 * `incomplete` -- once, with no retry -- and the production vault client reads
 * `classification_state: 'incomplete'` and the server's own sentence off
 * GET /vault/connection, which is what Settings renders. A later semantic pass
 * that completes turns the state `complete` and the sentence off.
 *
 * The lane's vault owner is the deployment-wide vault's owner, so the answer
 * also says `connected: false` -- the case the server reads a state for anyway.
 */
describe('a managed vault that sorts with its rules floor', () => {
  it('reads as not finished until a full sort lands', async () => {
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
      await control('classify-with-rules');
      setLlmApiKeyGetter(() => OWN_KEY);
      const before = await ledger();
      arranged = true;
      const rough = await classifyOnePage('The river carved a rough channel first.');
      expect(await landed('incomplete')).toMatchObject({
        run_id: rough.run_id,
        attempt_count: 1,
      });
      const calls = (await ledger()).received.slice(before.received.length);
      expect(calls.filter((call) => call.path === CLASSIFY)).toHaveLength(1);
      const roughAnswer = await vault.connection();
      expect(roughAnswer.connected).toBe(false);
      expect(roughAnswer.classification_state).toBe('incomplete');
      expect(roughAnswer.classification_message).toBe(ROUGH_SORT);

      await control('classify-with-llm');
      // Hold the next job again so its admission can be seen before it lands.
      await control('enable-pipeline');
      const full = await classifyOnePage('Then the water smoothed every stone in it.');
      expect(await landed('completed')).toMatchObject({ run_id: full.run_id });
      const fullAnswer = await vault.connection();
      expect(fullAnswer.classification_state).toBe('complete');
      expect(fullAnswer.classification_message).toBeNull();
    } finally {
      setLlmApiKeyGetter(null);
      await control('release-pipeline-jobs');
      if (arranged) await drained();
      setTokenGetter(null);
      await control('classify-with-llm');
      await control('disable-pipeline');
      await control('withdraw-request-keys');
    }
  });
});
