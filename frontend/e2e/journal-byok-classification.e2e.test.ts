import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

import {
  auth,
  corpus,
  journal,
  resetLlmApiKey,
  setLlmApiKeyGetter,
  setTokenGetter,
  vaultRequestKeys,
} from '@/api';

/** Production journal client → live server → managed vault; keys stay request-scoped. */
const OWN_KEY = 'sk-ant-api03-lane3550classificationKEYzz'; // pragma: allowlist secret
const HELPER = 'tests.e2e.keyed_classification';
const CLASSIFY = '/v1/classifications';
const HTTP_OK = 200;
const POLL_INTERVAL_MS = 100;
const SETTLE_MS = 15000;

interface Run {
  run_id: number;
  job_id: string | null;
  outcome: string;
  attempt_count: number;
}

interface Ledger {
  received: Array<{ method: string; path: string }>;
  keyed: Array<{ method: string; path: string; provider: string; keyDigest: string }>;
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

async function settled(): Promise<Run> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const state = run('show');
    if (state.outcome === 'completed') return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('the admitted classification never completed');
}

describe('a managed vault classifies with the writing request key', () => {
  it.each(['journal', 'document', 'upgraded document'] as const)(
    '%s commits the keyed handle before replying and polls it without the key',
    async (kind) => {
      resetLlmApiKey();
      const session = await auth.login({
        email: lane().vaultOwnerEmail,
        password: lane().vaultOwnerPassword,
      });
      setTokenGetter(() => session.token);
      setLlmApiKeyGetter(() => OWN_KEY);
      let arranged = false;
      try {
        if (kind === 'upgraded document') {
          await control('withdraw-request-keys');
          expect(await vaultRequestKeys.get()).toEqual([]);
        }
        await control('advertise-request-keys');
        await control('enable-pipeline');
        // A journal save stays non-blocking; explicit uploads discover vendors
        // themselves, including the first upload after a session starts.
        if (kind === 'journal') expect(await vaultRequestKeys.get()).toContain('anthropic');
        const before = await ledger();
        const queued = run('queue');
        arranged = true;
        if (kind === 'journal') {
          const entry = await journal.create({
            message: 'The willow bent all night and did not break.',
            classification: 'personal',
          });
          expect(entry.id).toBeGreaterThan(0);
        } else {
          const imported = await corpus.importDocument({
            filename: 'byok-first-upload.md',
            contentBase64: Buffer.from('A willow bent in the wind and kept its roots.').toString(
              'base64',
            ),
            classification: 'personal',
          });
          expect(imported.stored).toBe(true);
          expect(imported.vault_status).toBe('accepted');
        }
        const admitted = run('show');
        expect(admitted).toMatchObject({
          run_id: queued.run_id,
          outcome: 'attempted',
          attempt_count: 1,
        });
        expect(admitted.job_id).toMatch(/^[a-f0-9-]{36}$/u);
        expect((await ledger()).keyed.slice(before.keyed.length)).toEqual([
          {
            method: 'POST',
            path: CLASSIFY,
            provider: 'anthropic',
            keyDigest: createHash('sha256').update(OWN_KEY, 'utf8').digest('hex'),
          },
        ]);

        await control('release-pipeline-jobs');
        const finished = await settled();
        expect(finished).toMatchObject({
          run_id: admitted.run_id,
          job_id: admitted.job_id,
          attempt_count: 1,
        });
        const after = await ledger();
        const calls = after.received.slice(before.received.length);
        expect(calls.filter((call) => call.path === CLASSIFY)).toHaveLength(1);
        expect(calls.some((call) => call.path === `/v1/jobs/${admitted.job_id}`)).toBe(true);
        expect(after.keyed.slice(before.keyed.length)).toHaveLength(1);
      } finally {
        setLlmApiKeyGetter(null);
        setTokenGetter(null);
        await control('release-pipeline-jobs');
        if (arranged) await settled();
        await control('disable-pipeline');
        await control('withdraw-request-keys');
      }
    },
  );
});
