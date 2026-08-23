/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as FileSystem from 'expo-file-system';

import { importSeedDocument } from '../importSeedDocument';
import type { PickedDocument } from '../pickSeedDocuments';
import { MAX_SEED_DOCUMENT_BYTES } from '../readSeedDocument';

import { corpus } from '@/api';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

const mocked = FileSystem as unknown as {
  __fileBase64: jest.Mock;
  __fileSize: jest.Mock;
};

/** Distinctive fixture so a leak into a log or a payload is unmistakable. */
const SENTINEL_BASE64 = 'WlpaWl9TRU5USU5FTF9ET0NVTUVOVF9aWlpa';

function document(overrides: Partial<PickedDocument> = {}): PickedDocument {
  return { name: 'seed.md', uri: 'file:///cache/seed.md', size: 64, seedable: true, ...overrides };
}

function accepted(status = 202, body: unknown = undefined) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

/** What the endpoint answers an account that has connected no vault. */
function corpusReply(corpusStatus: string, fragmentId: number | null = null) {
  return accepted(202, {
    destination: 'corpus',
    stored: corpusStatus === 'stored',
    vault_status: null,
    vault_ref: null,
    tags: [],
    corpus_status: corpusStatus,
    fragment_id: fragmentId,
    message: 'something honest',
  });
}

/** What it answers an account that has one. */
function vaultReply(vaultStatus: string) {
  return accepted(202, {
    destination: 'vault',
    stored: vaultStatus === 'accepted',
    vault_status: vaultStatus,
    vault_ref: null,
    tags: [],
    corpus_status: null,
    fragment_id: null,
    message: 'something honest',
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue(SENTINEL_BASE64);
  mocked.__fileSize.mockReturnValue(64);
});

describe('picker to request body', () => {
  test('sends the picked file as base64 JSON under its own name and tier', async () => {
    mockFetch.mockReturnValueOnce(corpusReply('stored', 7));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('in_corpus');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/import');
    expect(JSON.parse(init.body)).toEqual({
      filename: 'seed.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
    });
  });

  test('carries the intimate tier through unchanged', async () => {
    mockFetch.mockReturnValueOnce(corpusReply('tier_refused'));

    await importSeedDocument(document(), 'intimate');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('an account with no vault', () => {
  test('gets its document into its own corpus, in one request', async () => {
    // The journey this surface exists for. Before the import route, an account
    // that had connected no vault was told its vault had not answered — untrue
    // of a vault they never had, and their corpus stayed empty forever.
    mockFetch.mockReturnValueOnce(corpusReply('stored', 12));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('in_corpus');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
  });

  test.each([
    ['stored', 'in_corpus'],
    ['consent_required', 'consent_required'],
    ['tier_refused', 'tier_refused'],
    ['format_unreadable', 'format_unreadable'],
    ['not_text', 'not_text'],
    ['empty_document', 'empty_document'],
    ['document_too_long', 'document_too_long'],
    ['unclassified', 'unclassified'],
  ])('renders the corpus %s answer as %s', async (wire, expected) => {
    mockFetch.mockReturnValueOnce(corpusReply(wire as string));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe(expected);
  });

  test('never falls back to the vault surface when the answer is corpus', async () => {
    mockFetch.mockReturnValue(corpusReply('consent_required'));

    await importSeedDocument(document(), 'personal');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.map((call) => call[0])).not.toContain('http://test/journal/upload');
  });
});

describe('an account that has a vault', () => {
  test.each([
    ['accepted', 'ingested'],
    ['vault_unavailable', 'vault_unavailable'],
    ['capability_unsupported', 'capability_unsupported'],
    ['degraded', 'degraded'],
  ])('renders the vault %s answer as %s', async (wire, expected) => {
    mockFetch.mockReturnValueOnce(vaultReply(wire as string));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe(expected);
  });

  test('reaches the same route as an account without one', async () => {
    // The routing rule is the server's, so the request is identical either way.
    mockFetch.mockReturnValueOnce(vaultReply('accepted'));

    await importSeedDocument(document(), 'personal');

    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
  });
});

describe('what never reaches the network', () => {
  test('an oversize document is refused on device', async () => {
    const status = await importSeedDocument(
      document({ size: MAX_SEED_DOCUMENT_BYTES + 1 }),
      'personal',
    );

    expect(status).toBe('too_large');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a format nothing can read is refused on device', async () => {
    const status = await importSeedDocument(
      document({ name: 'installer.exe', seedable: false }),
      'personal',
    );

    expect(status).toBe('unsupported_format');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a file that will not open is refused on device', async () => {
    mocked.__fileBase64.mockRejectedValue(new Error('gone'));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('unreadable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('a request that produced no outcome', () => {
  test('settles as failed rather than throwing at the run', async () => {
    mockFetch.mockReturnValue(accepted(500, { detail: 'boom' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('failed');
  });

  test('keeps the size verdict when the server is the one who caught it', async () => {
    mockFetch.mockReturnValue(accepted(413, { detail: 'document_too_large' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('too_large');
  });

  test('settles as failed when the answer names a destination but no outcome', async () => {
    // A body that cannot say what happened is not a body to render a sentence
    // from: "stored: false" alone is not one of the eight things that can be
    // wrong, and guessing which would put a sentence on screen nobody wrote.
    mockFetch.mockReturnValue(
      accepted(202, {
        destination: 'corpus',
        stored: false,
        corpus_status: null,
        tags: [],
        message: 'something honest',
      }),
    );

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('failed');
  });

  test('settles as failed when a vault answer carries no vault status', async () => {
    mockFetch.mockReturnValue(
      accepted(202, {
        destination: 'vault',
        stored: false,
        vault_status: null,
        tags: [],
        message: 'something honest',
      }),
    );

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('failed');
  });

  test('never writes the document bytes anywhere but the request body', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockFetch.mockReturnValueOnce(corpusReply('stored', 3));

    await importSeedDocument(document(), 'personal');

    const emitted = [warn, error, log].flatMap((spy) => spy.mock.calls.flat());
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL_BASE64);
    expect(corpus.importDocument).toBeDefined();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});
