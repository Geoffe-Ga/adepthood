/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, users } from '../index';
import type { DataExportArchive } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const ARCHIVE: DataExportArchive = {
  format: 'adepthood-export',
  format_version: 1,
  exported_at: '2026-08-22T00:00:00+00:00',
  records: { account: [{ email: 'me@example.com' }], journal_entries: [] },
  not_included: { loginattempt: 'Security telemetry.' },
};

const MARKDOWN = '# Your Adepthood journal\n\n## 2026-01-02\n\nSomething true.\n';

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

/** A body that is not JSON at all — which is what the Markdown route serves. */
function textResponse(body: string, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token # in JSON at position 0')),
    text: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('users.exportMyData', () => {
  test('GETs the export route with the caller`s token and no subject in the path', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ARCHIVE));

    const archive = await users.exportMyData('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/users/me/export');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(archive.records.journal_entries).toEqual([]);
  });

  test('rejects a body that is not an Adepthood archive', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...ARCHIVE, format: 'something-else' }));

    const err = await users.exportMyData('tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiValidationError);
  });

  test('rejects an archive with no collections key at all', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ format: 'adepthood-export' }));

    const err = await users.exportMyData('tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('users.exportMyJournalAsMarkdown', () => {
  test('reads the body as text, so Markdown does not have to survive a JSON parse', async () => {
    mockFetch.mockReturnValueOnce(textResponse(MARKDOWN));

    const journal = await users.exportMyJournalAsMarkdown('tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/users/me/export/journal.md');
    expect(journal).toBe(MARKDOWN);
  });
});

describe('users.exportMyVault', () => {
  test('reads the vault export as text, so it is saved exactly as the server sent it', async () => {
    const body = '{"format":"adepthood-vault-export","items":[],"complete":true}';
    mockFetch.mockReturnValueOnce(textResponse(body));

    const vault = await users.exportMyVault('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/users/me/export/vault');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(vault).toBe(body);
  });

  test('a vault that cannot export is an error carrying its code, not an empty file', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'vault_export_needs_update' }, 409));

    const err = await users.exportMyVault('tok').catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 409, detail: 'vault_export_needs_update' });
  });
});
