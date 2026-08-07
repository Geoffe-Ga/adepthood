import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, journal, setTokenGetter } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

const email = `e2e-journal-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII on purpose: a UTF-8 mishandling anywhere on the wire (request
// encoding, column collation, response encoding) breaks the round-trip below.
const body = `Reflexión sobre la vela 灯 y el río — ${randomUUID()}`;

describe('journal journey against a live server', () => {
  let sessionToken: string | null = null;
  let entryId = 0;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('creates an entry and returns it fully materialised', async () => {
    const created = await journal.create({ message: body });

    expect(created.id).toBeGreaterThan(0);
    expect(created.message).toBe(body);
    expect(created.sender).toBe('user');
    expect(created.tag).toBe('freeform');
    expect(created.classification).toBe('personal');
    expect(created.status).toBe('draft');
    expect(Number.isNaN(Date.parse(created.timestamp))).toBe(false);

    entryId = created.id;
  });

  it('lists exactly the one entry the account owns', async () => {
    const page = await journal.list();

    expect(page.total).toBe(1);
    expect(page.has_more).toBe(false);
    expect(page.items).toHaveLength(1);

    const [entry] = page.items;
    expect(entry?.id).toBe(entryId);
    expect(entry?.message).toBe(body);
    expect(entry?.sender).toBe('user');
  });

  it('round-trips the body byte-for-byte on a single-entry read', async () => {
    const entry = await journal.get(entryId);

    expect(entry.id).toBe(entryId);
    expect(entry.message).toBe(body);
    expect([...entry.message]).toEqual([...body]);
  });
});
