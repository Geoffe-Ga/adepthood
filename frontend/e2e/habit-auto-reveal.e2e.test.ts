import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, habits, setTokenGetter } from '@/api';

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const ISO_DATE_LENGTH = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ENERGY_COST = 2;
const ENERGY_RETURN = 5;
/** The first ring, open to a brand-new account from its first screen. */
const REACHED_STAGE = 'Beige';
/** The sixth ring; nine months of programme away from a brand-new account. */
const UNREACHED_STAGE = 'Green';

describe('habit auto-reveal journey against a live server', () => {
  afterAll(() => {
    setTokenGetter(null);
  });

  it('opens the ring the programme reached, holds the one it has not, and keeps a re-lock', async () => {
    const signup = await auth.signup({
      email: `e2e-auto-reveal-${randomUUID()}${EMAIL_DOMAIN}`,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    setTokenGetter(() => signup.token);

    const yesterday = new Date(Date.now() - ONE_DAY_MS).toISOString().slice(0, ISO_DATE_LENGTH);
    const common = {
      icon: 'candle',
      start_date: yesterday,
      energy_cost: ENERGY_COST,
      energy_return: ENERGY_RETURN,
      revealed: false,
    };
    // Same start date, already past, on both: the only thing that may separate
    // them is the ring each sits on (issue #2765).
    const reachedPayload = { ...common, name: `E2E Reached ${randomUUID()}`, stage: REACHED_STAGE };
    const unreachedPayload = {
      ...common,
      name: `E2E Unreached ${randomUUID()}`,
      stage: UNREACHED_STAGE,
    };
    const reached = await habits.create(reachedPayload);
    const unreached = await habits.create(unreachedPayload);
    expect(reached.revealed).toBe(false);
    expect(unreached.revealed).toBe(false);

    const invited = await habits.listAll();
    expect(invited.find((candidate) => candidate.id === reached.id)?.revealed).toBe(true);
    expect(invited.find((candidate) => candidate.id === unreached.id)?.revealed).toBe(false);

    const relocked = await habits.update(reached.id, reachedPayload);
    expect(relocked.revealed).toBe(false);

    const afterRelock = await habits.listAll();
    expect(afterRelock.find((candidate) => candidate.id === reached.id)?.revealed).toBe(false);
  });
});
