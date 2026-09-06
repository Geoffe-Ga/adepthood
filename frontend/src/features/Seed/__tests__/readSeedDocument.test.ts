/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

import type { PickedDocument } from '../pickSeedDocuments';
import {
  MAX_SEED_DOCUMENT_BYTES,
  readSeedDocument,
  SEED_DOCUMENT_READ_TIMEOUT_MS,
} from '../readSeedDocument';

const mocked = FileSystem as unknown as {
  __fileBase64: jest.Mock;
  __fileSize: jest.Mock;
};

const originalOS = Platform.OS;

function setPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function document(overrides: Partial<PickedDocument> = {}): PickedDocument {
  return { name: 'seed.md', uri: 'file:///cache/seed.md', size: 64, seedable: true, ...overrides };
}

beforeEach(() => {
  setPlatform(originalOS);
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(64);
});

afterEach(() => {
  setPlatform(originalOS);
  jest.useRealTimers();
});

describe('readSeedDocument', () => {
  test('returns the document base64-encoded', async () => {
    await expect(readSeedDocument(document())).resolves.toEqual({
      kind: 'read',
      contentBase64: 'c2VlZA==',
    });
  });

  test('falls back to the on-device size when the picker reported none', async () => {
    mocked.__fileSize.mockReturnValue(MAX_SEED_DOCUMENT_BYTES + 1);

    const result = await readSeedDocument(document({ size: null }));

    expect(result.kind).toBe('too_large');
  });

  test('refuses an oversize document without reading a byte of it', async () => {
    const result = await readSeedDocument(document({ size: MAX_SEED_DOCUMENT_BYTES + 1 }));

    expect(result.kind).toBe('too_large');
    expect(mocked.__fileBase64).not.toHaveBeenCalled();
  });

  test('admits a document sitting exactly on the cap', async () => {
    const result = await readSeedDocument(document({ size: MAX_SEED_DOCUMENT_BYTES }));

    expect(result.kind).toBe('read');
  });

  test('catches an oversize document the reported size understated', async () => {
    const oversizeGroups = Math.ceil(MAX_SEED_DOCUMENT_BYTES / 3) + 1;
    mocked.__fileBase64.mockResolvedValue('A'.repeat(oversizeGroups * 4));

    const result = await readSeedDocument(document({ size: 12 }));

    expect(result.kind).toBe('too_large');
  });

  test('reports an empty read as unreadable rather than sending nothing', async () => {
    mocked.__fileBase64.mockResolvedValue('');

    await expect(readSeedDocument(document())).resolves.toEqual({ kind: 'unreadable' });
  });

  test('contains a failed read instead of throwing at the run', async () => {
    mocked.__fileBase64.mockRejectedValue(new Error('file:///cache/seed.md is gone'));

    await expect(readSeedDocument(document())).resolves.toEqual({ kind: 'unreadable' });
  });

  test('leaves the native Expo filesystem path unchanged', async () => {
    setPlatform('ios');
    const arrayBuffer = jest.fn(() => Promise.reject(new Error('web path must stay unused')));

    await expect(
      readSeedDocument(document({ browserFile: { size: 4, arrayBuffer } as unknown as File })),
    ).resolves.toEqual({
      kind: 'read',
      contentBase64: 'c2VlZA==',
    });
    expect(mocked.__fileBase64).toHaveBeenCalledWith('file:///cache/seed.md');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test('reads the browser File instead of reopening its blob URI through the native filesystem', async () => {
    setPlatform('web');
    const browserFile = new File(['seed'], 'seed.md', { type: 'text/markdown' });

    await expect(readSeedDocument(document({ browserFile }))).resolves.toEqual({
      kind: 'read',
      contentBase64: 'c2VlZA==',
    });
    expect(mocked.__fileBase64).not.toHaveBeenCalled();
  });

  test('settles a browser read that never answers within the bounded read window', async () => {
    jest.useFakeTimers();
    setPlatform('web');
    const browserFile = {
      size: 4,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
    } as unknown as File;

    const read = readSeedDocument(document({ browserFile }));
    await jest.advanceTimersByTimeAsync(SEED_DOCUMENT_READ_TIMEOUT_MS);

    await expect(read).resolves.toEqual({ kind: 'unreadable' });
    expect(mocked.__fileBase64).not.toHaveBeenCalled();
  });

  test('settles promptly when a web picker result unexpectedly has no browser File', async () => {
    setPlatform('web');

    await expect(readSeedDocument(document())).resolves.toEqual({ kind: 'unreadable' });
    expect(mocked.__fileBase64).not.toHaveBeenCalled();
  });
});
