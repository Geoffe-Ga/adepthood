/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '../pickSeedDocuments';
import { MAX_SEED_DOCUMENT_BYTES } from '../readSeedDocument';
import { uploadSeedDocument } from '../uploadSeedDocument';

import { journal } from '@/api';

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

function vaultResponse(status: string, message = 'ok') {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ status, vault_ref: null, tags: [], message }),
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
    mockFetch.mockReturnValueOnce(vaultResponse('accepted'));

    const status = await uploadSeedDocument(document(), 'personal');

    expect(status).toBe('ingested');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/upload');
    expect(JSON.parse(init.body)).toEqual({
      filename: 'seed.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
    });
  });

  test('carries the intimate tier through unchanged', async () => {
    mockFetch.mockReturnValueOnce(vaultResponse('accepted'));

    await uploadSeedDocument(document(), 'intimate');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('what never reaches the network', () => {
  test('an oversize document is refused on device', async () => {
    const status = await uploadSeedDocument(
      document({ size: MAX_SEED_DOCUMENT_BYTES + 1 }),
      'personal',
    );

    expect(status).toBe('too_large');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a format the vault cannot read is refused on device', async () => {
    const status = await uploadSeedDocument(
      document({ name: 'installer.exe', seedable: false }),
      'personal',
    );

    expect(status).toBe('unsupported_format');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a file that will not open is refused on device', async () => {
    mocked.__fileBase64.mockRejectedValue(new Error('gone'));

    const status = await uploadSeedDocument(document(), 'personal');

    expect(status).toBe('unreadable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('what the vault answers', () => {
  test.each([
    ['accepted', 'ingested'],
    ['vault_unavailable', 'vault_unavailable'],
    ['capability_unsupported', 'capability_unsupported'],
    ['degraded', 'degraded'],
  ])('renders %s as %s', async (wire, expected) => {
    mockFetch.mockReturnValueOnce(vaultResponse(wire as string));

    await expect(uploadSeedDocument(document(), 'personal')).resolves.toBe(expected);
  });
});

describe('a request that produced no outcome', () => {
  test('settles as failed rather than throwing at the run', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ detail: 'boom' }) }),
    );

    await expect(uploadSeedDocument(document(), 'personal')).resolves.toBe('failed');
  });

  test('keeps the size verdict when the server is the one who caught it', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 413,
        json: () => Promise.resolve({ detail: 'document_too_large' }),
      }),
    );

    await expect(uploadSeedDocument(document(), 'personal')).resolves.toBe('too_large');
  });

  test('never writes the document bytes anywhere but the request body', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockFetch.mockReturnValueOnce(vaultResponse('accepted'));

    await uploadSeedDocument(document(), 'personal');

    const emitted = [warn, error, log].flatMap((spy) => spy.mock.calls.flat());
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL_BASE64);
    expect(journal.uploadDocument).toBeDefined();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});
