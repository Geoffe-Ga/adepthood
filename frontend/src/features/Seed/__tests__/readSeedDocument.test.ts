/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as FileSystem from 'expo-file-system';

import type { PickedDocument } from '../pickSeedDocuments';
import { MAX_SEED_DOCUMENT_BYTES, readSeedDocument } from '../readSeedDocument';

const mocked = FileSystem as unknown as {
  __fileBase64: jest.Mock;
  __fileSize: jest.Mock;
};

function document(overrides: Partial<PickedDocument> = {}): PickedDocument {
  return { name: 'seed.md', uri: 'file:///cache/seed.md', size: 64, seedable: true, ...overrides };
}

beforeEach(() => {
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(64);
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
});
