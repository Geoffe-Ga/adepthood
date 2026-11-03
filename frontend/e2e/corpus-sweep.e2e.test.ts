import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import {
  auth,
  corpus,
  corpusConsent,
  journal,
  setTokenGetter,
  type CorpusSweepEstimate,
} from '@/api';

/**
 * Sort the rest of your writing, proven across the wire (#3499).
 *
 * The Settings row and its screen read ``GET /corpus/sweep`` to decide whether
 * to offer anything and to follow a sort, and ``POST /corpus/sweep`` to start
 * one -- a background run that sorts everything waiting from one press. Their
 * Jest suites mock the client, and the router's suites never see it, so this is
 * where the two agree on the paths, the verbs, the empty body, the counts, the
 * run, and the promises the screen is built on:
 *
 * - the count is the account's own writing apart from anything marked
 *   Intimate, and nobody else's;
 * - a press without a standing yes is answered at once with a run that stopped
 *   for that reason, sorting nothing and leaving the remainder unchanged;
 * - under a standing yes the press returns before the sort is done, and the
 *   run it names is the one the next reads follow until it ends -- real
 *   background work on the live server, not a mock of it;
 *
 * What it does not assert is how many entries a granted pass classifies: that
 * is the lane's provider stub, not the seam. Nor the per-account limit on
 * passes: the lane's server runs with rate limiting off, so the ``429`` the
 * screen meets with a retry-later line is pinned by the backend's route tests
 * and the screen's own Jest suite.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';

/** The source the sweep sorts. */
const JOURNAL = 'journal';

/** How long a sort of a handful of entries may take on the lane before the spec gives up. */
const SETTLE_MS = 15000;
const POLL_INTERVAL_MS = 100;

/** Two entries the sweep may reach and one it never may. */
const SORTABLE_ENTRIES = ['A first page, from before sorting.', 'A second one.'];
const INTIMATE_ENTRY = 'Something kept to myself.';

const email = `e2e-sweep-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-sweep-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

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

describe('corpus-sweep journey against a live server', () => {
  let sessionToken: string | null = null;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    sessionToken = response.token;
    setTokenGetter(() => sessionToken);

    // Nothing written, nothing waiting, never sorted: the row stays hidden.
    expect(await corpus.sweepEstimate()).toEqual({ entries_pending: 0, run: null });
  });

  it('counts the writing that predates sorting, apart from anything marked Intimate', async () => {
    for (const message of SORTABLE_ENTRIES) {
      await journal.create({ message });
    }
    await journal.create({ message: INTIMATE_ENTRY, classification: 'intimate' });

    expect((await corpus.sweepEstimate()).entries_pending).toBe(SORTABLE_ENTRIES.length);
  });

  it('answers a press without consent at once, with a run that stopped for that reason', async () => {
    const press = await corpus.sweep();

    expect(press).toMatchObject({
      entries_pending: SORTABLE_ENTRIES.length,
      entries_sorted: 0,
      entries_remaining: SORTABLE_ENTRIES.length,
    });
    expect(press.run).toMatchObject({
      state: 'stopped',
      stop_reason: 'no_consent',
      entries_sorted: 0,
    });
    const read = await corpus.sweepEstimate();
    expect(read.entries_pending).toBe(SORTABLE_ENTRIES.length);
    expect(read.run?.id).toBe(press.run?.id);
  });

  it('under a standing yes, one press starts a run the next reads follow to its end', async () => {
    await corpusConsent.set(JOURNAL, true);
    const before = (await corpus.sweepEstimate()).entries_pending;

    const press = await corpus.sweep();
    const after = await settled();

    expect(press.run?.entries_total).toBe(before);
    expect(after.run?.id).toBe(press.run?.id);
    expect(after.run?.state).toBe('completed');
    expect(after.run?.finished_at).not.toBeNull();
    expect(after.run?.entries_sorted).toBeLessThanOrEqual(before);
    expect(after.entries_pending).toBeLessThanOrEqual(before);
  });

  it("keeps one account's backlog off another account", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    const ownToken = sessionToken;
    sessionToken = neighbour.token;
    try {
      expect(await corpus.sweepEstimate()).toEqual({ entries_pending: 0, run: null });
    } finally {
      sessionToken = ownToken;
    }
  });
});
