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

describe('habit auto-reveal journey against a live server', () => {
  afterAll(() => {
    setTokenGetter(null);
  });

  it('reveals an eligible habit once and preserves a later manual re-lock', async () => {
    const signup = await auth.signup({
      email: `e2e-auto-reveal-${randomUUID()}${EMAIL_DOMAIN}`,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    setTokenGetter(() => signup.token);

    const yesterday = new Date(Date.now() - ONE_DAY_MS).toISOString().slice(0, ISO_DATE_LENGTH);
    const payload = {
      name: `E2E Auto Reveal ${randomUUID()}`,
      icon: 'candle',
      start_date: yesterday,
      energy_cost: ENERGY_COST,
      energy_return: ENERGY_RETURN,
      stage: 'Green',
      revealed: false,
    };
    const created = await habits.create(payload);
    expect(created.revealed).toBe(false);

    const invited = (await habits.listAll()).find((candidate) => candidate.id === created.id);
    expect(invited?.revealed).toBe(true);

    const relocked = await habits.update(created.id, payload);
    expect(relocked.revealed).toBe(false);

    const afterRelock = (await habits.listAll()).find((candidate) => candidate.id === created.id);
    expect(afterRelock?.revealed).toBe(false);
  });
});
