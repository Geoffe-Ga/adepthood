/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as FileSystem from 'expo-file-system';

import { releaseAllPageFiles, releasePageFiles, releaseUris } from '../cleanupPageFiles';

// The mock exposes the two spies behind ``File``: which uris were deleted, and
// what ``exists`` reports for each. SDK 57's ``File.delete()`` is synchronous
// and throws on a missing file, so both are needed to cover cleanup's branches.
// Read off the namespace import rather than jest.requireMock so the spies are
// the very ones the module under test holds -- moduleNameMapper resolves a
// requireMock of the same specifier to a separate copy.
const { __deleteFile: deleteFile, __fileExists: fileExists } = FileSystem as unknown as {
  __deleteFile: jest.Mock;
  __fileExists: jest.Mock;
};

const SOURCE_URI = 'file:///cache/ImagePicker/source-1.jpg';
const OUTPUT_URI = 'file:///cache/manipulated/output-1.jpg';
const SECOND_SOURCE_URI = 'file:///cache/ImagePicker/source-2.jpg';
const SECOND_OUTPUT_URI = 'file:///cache/manipulated/output-2.jpg';

type PageFiles = Parameters<typeof releasePageFiles>[0];

function pageFiles(overrides: Partial<PageFiles> = {}): PageFiles {
  return { sourceUri: SOURCE_URI, uri: OUTPUT_URI, ...overrides } as PageFiles;
}

function silenceWarnings() {
  return jest.spyOn(console, 'warn').mockImplementation(() => undefined);
}

beforeEach(() => {
  deleteFile.mockReset();
  fileExists.mockReset();
  fileExists.mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('releasePageFiles', () => {
  it('deletes both the picker source file and the prepared output file', async () => {
    await releasePageFiles(pageFiles());
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith(SOURCE_URI);
    expect(deleteFile).toHaveBeenCalledWith(OUTPUT_URI);
  });

  it('treats an already-absent file as done, deleting nothing and warning nothing', async () => {
    const warn = silenceWarnings();
    fileExists.mockReturnValue(false);
    await expect(releasePageFiles(pageFiles())).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a failed delete, still attempting the other file', async () => {
    silenceWarnings();
    deleteFile.mockImplementationOnce(() => {
      throw new Error(`unlink failed for ${SOURCE_URI}`);
    });
    await expect(releasePageFiles(pageFiles())).resolves.toBeUndefined();
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith(OUTPUT_URI);
  });

  it('warns with only the cache-relative filename, never a full path or image data', async () => {
    const warn = silenceWarnings();
    // Every delete fails, and the raised error itself carries a full path; the
    // warning must still surface nothing beyond the cache-relative name.
    deleteFile.mockImplementation(() => {
      throw new Error('unlink failed for file:///cache/ImagePicker/page-photo.jpg');
    });
    const page = {
      ...pageFiles({ sourceUri: 'file:///cache/ImagePicker/page-photo.jpg' }),
      imageBase64: 'VEVSU0VDUkVU',
    } as PageFiles;
    await releasePageFiles(page);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('ImagePicker/page-photo.jpg');
    expect(logged).not.toContain('file:///');
    expect(logged).not.toContain('VEVSU0VDUkVU');
  });
});

describe('releaseAllPageFiles', () => {
  it('deletes the source and output files of every page in the batch', async () => {
    const second = pageFiles({ sourceUri: SECOND_SOURCE_URI, uri: SECOND_OUTPUT_URI });
    await releaseAllPageFiles([pageFiles(), second]);
    expect(deleteFile).toHaveBeenCalledTimes(4);
    expect(deleteFile).toHaveBeenCalledWith(SOURCE_URI);
    expect(deleteFile).toHaveBeenCalledWith(OUTPUT_URI);
    expect(deleteFile).toHaveBeenCalledWith(SECOND_SOURCE_URI);
    expect(deleteFile).toHaveBeenCalledWith(SECOND_OUTPUT_URI);
  });

  it('keeps releasing later pages when an earlier delete fails', async () => {
    silenceWarnings();
    deleteFile.mockImplementationOnce(() => {
      throw new Error('busy');
    });
    const second = pageFiles({ sourceUri: SECOND_SOURCE_URI, uri: SECOND_OUTPUT_URI });
    await expect(releaseAllPageFiles([pageFiles(), second])).resolves.toBeUndefined();
    expect(deleteFile).toHaveBeenCalledTimes(4);
    expect(deleteFile).toHaveBeenCalledWith(SECOND_OUTPUT_URI);
  });

  it('resolves without touching the filesystem for an empty batch', async () => {
    await expect(releaseAllPageFiles([])).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe('releaseUris', () => {
  it('deletes every uri in the set', async () => {
    await releaseUris([SOURCE_URI, OUTPUT_URI, SECOND_SOURCE_URI]);
    expect(deleteFile).toHaveBeenCalledTimes(3);
    expect(deleteFile).toHaveBeenCalledWith(SOURCE_URI);
    expect(deleteFile).toHaveBeenCalledWith(OUTPUT_URI);
    expect(deleteFile).toHaveBeenCalledWith(SECOND_SOURCE_URI);
  });

  it('swallows a failed delete and still attempts the rest', async () => {
    silenceWarnings();
    deleteFile.mockImplementationOnce(() => {
      throw new Error('busy');
    });
    await expect(releaseUris([SOURCE_URI, OUTPUT_URI])).resolves.toBeUndefined();
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith(OUTPUT_URI);
  });

  it('resolves without touching the filesystem for an empty set', async () => {
    await expect(releaseUris([])).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe('the module under test', () => {
  it('uses the modern File API rather than the legacy deleteAsync that throws in SDK 57', () => {
    // Guards the migration: expo-file-system still *type-checks* deleteAsync via
    // legacyWarnings.d.ts, whose own docblock says it throws at runtime. A
    // regression to it would keep passing tsc, so it is asserted here instead.
    expect(typeof FileSystem.File).toBe('function');
    expect(FileSystem).not.toHaveProperty('deleteAsync');
  });
});
