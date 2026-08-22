import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, journal, setTokenGetter, users } from '@/api';

/**
 * Taking your writing with you, across the wire.
 *
 * Both halves are already covered on their own side: the screen's tests mock
 * `saveDataExport`, and the route's tests drive the manifest from
 * `SQLModel.metadata`. Neither can see a disagreement between them — a renamed
 * collection key, a moved path, a `records` envelope the Zod schema rejects —
 * and the failure that disagreement produces is an export button that throws in
 * a released app, on the one screen a person reaches when they have decided to
 * leave.
 *
 * The Markdown half is here for a second reason: it is the only route in the
 * client that does not serve JSON, so it is the only exercise of
 * `responseType: 'text'` against a real body.
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';

const email = `e2e-data-export-${randomUUID()}${EMAIL_DOMAIN}`;
const somebodyElse = `e2e-not-my-export-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII on purpose: the archive has to survive the round trip intact.
const body = `Lo que quiero llevarme conmigo 灯 — ${randomUUID()}`;
const theirBody = `Nothing of mine 燈 — ${randomUUID()}`;

describe('data-export journey against a live server', () => {
  let sessionToken: string | null = null;

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

  it('writes something worth taking away', async () => {
    const created = await journal.create({ message: body });

    expect(created.id).toBeGreaterThan(0);
  });

  it('exports an archive that carries the entry back, readable', async () => {
    const archive = await users.exportMyData();

    expect(archive.format).toBe('adepthood-export');
    expect(archive.format_version).toBeGreaterThan(0);
    // The account's own row, under the collection name the manifest gives it.
    expect(archive.records.account).toHaveLength(1);
    // The entry itself, as prose rather than as whatever the column holds.
    expect(JSON.stringify(archive.records.journal_entries)).toContain(body);
  });

  it('says what it deliberately left out, rather than implying it took everything', async () => {
    const archive = await users.exportMyData();

    expect(Object.keys(archive.not_included).length).toBeGreaterThan(0);
    // The password hash is never in the archive, under any key.
    expect(JSON.stringify(archive.records)).not.toContain('password_hash');
  });

  it('exports the journal as Markdown a person can just read', async () => {
    const markdown = await users.exportMyJournalAsMarkdown();

    expect(markdown.startsWith('# ')).toBe(true);
    expect(markdown).toContain(body);
  });

  it('never carries another account`s writing', async () => {
    const theirs = await auth.signup({
      email: somebodyElse,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    const mine = sessionToken;
    sessionToken = theirs.token;
    await journal.create({ message: theirBody });
    sessionToken = mine;

    const archive = await users.exportMyData();
    const markdown = await users.exportMyJournalAsMarkdown();

    expect(JSON.stringify(archive)).not.toContain(theirBody);
    expect(JSON.stringify(archive)).not.toContain(somebodyElse);
    expect(markdown).not.toContain(theirBody);
  });
});
