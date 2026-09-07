/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as FileSystem from 'expo-file-system';
import { Platform, Share } from 'react-native';

import { countRecords, saveDataExport } from '../saveDataExport';

import { users, type DataExportArchive } from '@/api';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    users: { exportMyData: jest.fn(), exportMyJournalAsMarkdown: jest.fn() },
  };
});

const mockExportMyData = users.exportMyData as jest.MockedFunction<typeof users.exportMyData>;
const mockExportMarkdown = users.exportMyJournalAsMarkdown as jest.MockedFunction<
  typeof users.exportMyJournalAsMarkdown
>;

const fs = FileSystem as unknown as {
  __createFile: jest.Mock;
  __writeFile: jest.Mock;
};

const ARCHIVE: DataExportArchive = {
  format: 'adepthood-export',
  format_version: 1,
  exported_at: '2026-08-22T00:00:00+00:00',
  records: {
    account: [{ email: 'me@example.com' }],
    journal_entries: [{ message: 'one' }, { message: 'two' }],
    habits: [],
  },
  not_included: { loginattempt: 'Security telemetry.' },
};

const MARKDOWN = '# Your Adepthood journal\n\n## 2026-01-02\n\nSomething true.\n';

let shareSpy: jest.SpyInstance;
const originalPlatform = Platform.OS;
const originalBlob = globalThis.Blob;
const originalDocument = globalThis.document;
const originalUrl = globalThis.URL;

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.useFakeTimers().setSystemTime(new Date('2026-08-22T10:00:00Z'));
  mockExportMyData.mockResolvedValue(ARCHIVE);
  mockExportMarkdown.mockResolvedValue(MARKDOWN);
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  Object.defineProperty(globalThis, 'Blob', { configurable: true, value: originalBlob });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
  jest.useRealTimers();
});

describe('countRecords', () => {
  test('adds up every collection in the archive', () => {
    expect(countRecords(ARCHIVE)).toBe(3);
  });

  test('an archive with nothing in it counts zero rather than throwing', () => {
    expect(countRecords({ ...ARCHIVE, records: {} })).toBe(0);
  });
});

describe('saveDataExport (JSON)', () => {
  test('writes the archive to a dated file in the document directory', async () => {
    const saved = await saveDataExport('json');

    expect(saved.filename).toBe('adepthood-export-2026-08-22.json');
    expect(fs.__writeFile).toHaveBeenCalledWith(
      'file:///documents/adepthood-export-2026-08-22.json',
      JSON.stringify(ARCHIVE, null, 2),
    );
    expect(saved.records).toBe(3);
  });

  test('overwrites an earlier copy rather than accumulating duplicates', async () => {
    await saveDataExport('json');

    expect(fs.__createFile).toHaveBeenCalledWith(
      'file:///documents/adepthood-export-2026-08-22.json',
      expect.objectContaining({ overwrite: true }),
    );
  });

  test('offers the saved file to the share sheet', async () => {
    const saved = await saveDataExport('json');

    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'file:///documents/adepthood-export-2026-08-22.json' }),
    );
    expect(saved.destination).toBe('shared');
  });

  test('a dismissed share still leaves the file written', async () => {
    shareSpy.mockResolvedValue({ action: Share.dismissedAction });

    const saved = await saveDataExport('json');

    expect(saved.destination).toBe('device-file');
    expect(fs.__writeFile).toHaveBeenCalled();
  });

  test('an unavailable share sheet is not an export failure', async () => {
    shareSpy.mockRejectedValue(new Error('no share sheet here'));

    const saved = await saveDataExport('json');

    expect(saved.destination).toBe('device-file');
    expect(saved.filename).toBe('adepthood-export-2026-08-22.json');
  });

  test('a failed download writes nothing at all', async () => {
    mockExportMyData.mockRejectedValue(new Error('network_error'));

    await expect(saveDataExport('json')).rejects.toThrow('network_error');
    expect(fs.__writeFile).not.toHaveBeenCalled();
  });
});

describe('saveDataExport on web', () => {
  type DownloadedFile = { contents: string; mediaType: string; filename: string };

  function captureDownload(): { downloaded: DownloadedFile[]; revokeObjectURL: jest.Mock } {
    jest.replaceProperty(Platform, 'OS', 'web');
    const downloaded: DownloadedFile[] = [];
    const blobs = new Map<string, { parts: string[]; options: { type: string } }>();
    const revokeObjectURL = jest.fn();
    class FakeBlob {
      constructor(
        readonly parts: string[],
        readonly options: { type: string },
      ) {}
    }
    const createObjectURL = jest.fn((blob: FakeBlob) => {
      const url = `blob:export-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    });
    Object.defineProperty(globalThis, 'Blob', { configurable: true, value: FakeBlob });
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: { createObjectURL, revokeObjectURL },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: jest.fn() },
        createElement: () => {
          const anchor = {
            href: '',
            download: '',
            click: () => {
              const blob = blobs.get(anchor.href);
              if (!blob) throw new Error('download did not point at generated content');
              downloaded.push({
                contents: blob.parts.join(''),
                mediaType: blob.options.type,
                filename: anchor.download,
              });
            },
            remove: jest.fn(),
          };
          return anchor;
        },
      },
    });
    return { downloaded, revokeObjectURL };
  }

  test('a successful JSON API response reaches the browser download action', async () => {
    const { downloaded, revokeObjectURL } = captureDownload();

    const saved = await saveDataExport('json');

    expect(downloaded).toEqual([
      {
        contents: JSON.stringify(ARCHIVE, null, 2),
        mediaType: 'application/json;charset=utf-8',
        filename: 'adepthood-export-2026-08-22.json',
      },
    ]);
    expect(saved).toMatchObject({ destination: 'browser-download', uri: null, records: 3 });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export-0');
    expect(fs.__writeFile).not.toHaveBeenCalled();
    expect(shareSpy).not.toHaveBeenCalled();
  });

  test('a successful Markdown API response reaches its own browser download', async () => {
    const { downloaded } = captureDownload();

    const saved = await saveDataExport('markdown');

    expect(downloaded).toEqual([
      {
        contents: MARKDOWN,
        mediaType: 'text/markdown;charset=utf-8',
        filename: 'adepthood-journal-2026-08-22.md',
      },
    ]);
    expect(saved.destination).toBe('browser-download');
  });

  test('an unavailable browser download surface fails instead of claiming success', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });

    await expect(saveDataExport('json')).rejects.toThrow('browser download');
    expect(fs.__writeFile).not.toHaveBeenCalled();
  });
});

describe('saveDataExport (Markdown)', () => {
  test('writes the journal verbatim under its own name', async () => {
    const saved = await saveDataExport('markdown');

    expect(saved.filename).toBe('adepthood-journal-2026-08-22.md');
    expect(fs.__writeFile).toHaveBeenCalledWith(
      'file:///documents/adepthood-journal-2026-08-22.md',
      MARKDOWN,
    );
  });

  test('reports no record count, because prose is not rows', async () => {
    const saved = await saveDataExport('markdown');

    expect(saved.records).toBeNull();
    expect(mockExportMyData).not.toHaveBeenCalled();
  });
});
