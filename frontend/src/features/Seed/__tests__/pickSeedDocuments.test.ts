/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import * as DocumentPicker from 'expo-document-picker';

import {
  isSeedableFilename,
  pickSeedDocuments,
  SEED_DOCUMENT_EXTENSIONS,
} from '../pickSeedDocuments';

const getDocumentAsync = DocumentPicker.getDocumentAsync as unknown as jest.Mock;

function asset(name: string, extra: Record<string, unknown> = {}) {
  return { name, uri: `file:///cache/${name}`, size: 1024, lastModified: 0, ...extra };
}

beforeEach(() => {
  getDocumentAsync.mockReset();
});

describe('the formats a seed pick offers', () => {
  test('covers the vault-readable set, archives included', () => {
    expect(SEED_DOCUMENT_EXTENSIONS.length).toBeGreaterThanOrEqual(10);
    for (const ext of ['.md', '.txt', '.pdf', '.docx', '.rtf', '.html', '.csv', '.xlsx', '.pptx']) {
      expect(SEED_DOCUMENT_EXTENSIONS).toContain(ext);
    }
    expect(SEED_DOCUMENT_EXTENSIONS).toContain('.zip');
    expect(SEED_DOCUMENT_EXTENSIONS).toContain('.jpg');
  });

  test('reads the extension case-insensitively', () => {
    expect(isSeedableFilename('Export.ZIP')).toBe(true);
    expect(isSeedableFilename('notes.Md')).toBe(true);
  });

  test('turns down what the vault has no ingestor for', () => {
    expect(isSeedableFilename('app.exe')).toBe(false);
    expect(isSeedableFilename('README')).toBe(false);
  });

  test('turns down a name the backend would refuse', () => {
    expect(isSeedableFilename('../escape.md')).toBe(false);
    expect(isSeedableFilename('.hidden.md')).toBe(false);
    expect(isSeedableFilename('  spaced.md  ')).toBe(false);
  });
});

describe('pickSeedDocuments', () => {
  test('opens the picker for an unfiltered multi-selection copied to cache', async () => {
    getDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });

    await pickSeedDocuments();

    expect(getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, copyToCacheDirectory: true }),
    );
  });

  test('reports a backed-out pick as cancelled', async () => {
    getDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });

    await expect(pickSeedDocuments()).resolves.toEqual({ kind: 'cancelled' });
  });

  test('returns every picked document in selection order', async () => {
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [asset('first.md'), asset('second.pdf')],
    });

    const result = await pickSeedDocuments();

    expect(result).toEqual({
      kind: 'picked',
      documents: [
        { name: 'first.md', uri: 'file:///cache/first.md', size: 1024, seedable: true },
        { name: 'second.pdf', uri: 'file:///cache/second.pdf', size: 1024, seedable: true },
      ],
    });
  });

  test('keeps an unreadable-format pick, marked so the run can say why', async () => {
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [asset('notes.md'), asset('installer.exe')],
    });

    const result = await pickSeedDocuments();

    expect(result.kind).toBe('picked');
    if (result.kind !== 'picked') return;
    expect(result.documents.map((doc) => doc.seedable)).toEqual([true, false]);
  });

  test('drops an asset with no file uri rather than queueing a phantom', async () => {
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [asset('ghost.md', { uri: '' })],
    });

    await expect(pickSeedDocuments()).resolves.toEqual({ kind: 'failed' });
  });

  test('treats an empty selection as a failed pick', async () => {
    getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [] });

    await expect(pickSeedDocuments()).resolves.toEqual({ kind: 'failed' });
  });
});
