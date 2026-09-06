import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { auth, habits, setTokenGetter } from '@/api';

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

const email = `e2e-habits-empty-${randomUUID()}${EMAIL_DOMAIN}`;

describe('fresh habit state against a live server', () => {
  afterAll(() => {
    setTokenGetter(null);
  });

  it('returns a truthful empty collection for a newly registered person', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    setTokenGetter(() => response.token);

    await expect(habits.listAll()).resolves.toEqual([]);
  });
});
