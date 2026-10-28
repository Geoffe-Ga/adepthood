import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, corpus, corpusConsent, journal, setTokenGetter } from '@/api';

/**
 * Sort the rest of your writing, proven across the wire (#3499).
 *
 * The Settings row and its screen read ``GET /corpus/sweep`` to decide whether
 * to offer anything and ``POST /corpus/sweep`` to run one bounded pass. Their
 * Jest suites mock the client, and the router's suites never see it, so this is
 * where the two agree on the paths, the verbs, the empty body, the three
 * counts, and the promises the screen is built on:
 *
 * - the count is the account's own writing apart from anything marked
 *   Intimate, and nobody else's;
 * - a pass without a standing yes is a 200 that sorts nothing and reports the
 *   remainder unchanged -- which is why the screen must never read
 *   ``entries_sorted: 0`` as success;
 * - ``entries_pending`` and ``entries_remaining`` agree with each other and
 *   with the next read;
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

/** Two entries the sweep may reach and one it never may. */
const SORTABLE_ENTRIES = ['A first page, from before sorting.', 'A second one.'];
const INTIMATE_ENTRY = 'Something kept to myself.';

const email = `e2e-sweep-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-sweep-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

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

    // Nothing written, nothing waiting: the row this read gates stays hidden.
    expect(await corpus.sweepEstimate()).toEqual({ entries_pending: 0 });
  });

  it('counts the writing that predates sorting, apart from anything marked Intimate', async () => {
    for (const message of SORTABLE_ENTRIES) {
      await journal.create({ message });
    }
    await journal.create({ message: INTIMATE_ENTRY, classification: 'intimate' });

    expect(await corpus.sweepEstimate()).toEqual({ entries_pending: SORTABLE_ENTRIES.length });
  });

  it('answers a pass without consent with a count, sorting nothing and leaving the remainder', async () => {
    const pass = await corpus.sweep();

    expect(pass).toEqual({
      entries_pending: SORTABLE_ENTRIES.length,
      entries_sorted: 0,
      entries_remaining: SORTABLE_ENTRIES.length,
    });
    expect(await corpus.sweepEstimate()).toEqual({ entries_pending: SORTABLE_ENTRIES.length });
  });

  it('under a standing yes, reports a remainder that agrees with the next read', async () => {
    await corpusConsent.set(JOURNAL, true);
    const before = (await corpus.sweepEstimate()).entries_pending;

    const pass = await corpus.sweep();

    expect(pass.entries_pending).toBe(pass.entries_remaining);
    expect(pass.entries_remaining).toBeLessThanOrEqual(before);
    expect(pass.entries_sorted).toBeLessThanOrEqual(before);
    expect(await corpus.sweepEstimate()).toEqual({ entries_pending: pass.entries_remaining });
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
      expect(await corpus.sweepEstimate()).toEqual({ entries_pending: 0 });
    } finally {
      sessionToken = ownToken;
    }
  });
});
