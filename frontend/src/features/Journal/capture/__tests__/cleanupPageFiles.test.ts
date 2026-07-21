/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as FileSystem from 'expo-file-system';

import { releaseAllPageFiles, releasePageFiles, releaseUris } from '../cleanupPageFiles';

const deleteAsync = jest.mocked(FileSystem.deleteAsync);

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
  deleteAsync.mockReset();
  deleteAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('releasePageFiles', () => {
  it('deletes both the picker source file and the prepared output file idempotently', async () => {
    await releasePageFiles(pageFiles());
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(deleteAsync).toHaveBeenCalledWith(SOURCE_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(OUTPUT_URI, { idempotent: true });
  });

  it('swallows a rejected delete, still attempting the other file', async () => {
    silenceWarnings();
    deleteAsync.mockRejectedValueOnce(new Error(`unlink failed for ${SOURCE_URI}`));
    await expect(releasePageFiles(pageFiles())).resolves.toBeUndefined();
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(deleteAsync).toHaveBeenCalledWith(OUTPUT_URI, { idempotent: true });
  });

  it('warns with only the cache-relative filename, never a full path or image data', async () => {
    const warn = silenceWarnings();
    // Every delete fails, and the raised error itself carries a full path; the
    // warning must still surface nothing beyond the cache-relative name.
    deleteAsync.mockRejectedValue(
      new Error('unlink failed for file:///cache/ImagePicker/page-photo.jpg'),
    );
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
    expect(deleteAsync).toHaveBeenCalledTimes(4);
    expect(deleteAsync).toHaveBeenCalledWith(SOURCE_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(OUTPUT_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(SECOND_SOURCE_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(SECOND_OUTPUT_URI, { idempotent: true });
  });

  it('keeps releasing later pages when an earlier delete rejects', async () => {
    silenceWarnings();
    deleteAsync.mockRejectedValueOnce(new Error('busy'));
    const second = pageFiles({ sourceUri: SECOND_SOURCE_URI, uri: SECOND_OUTPUT_URI });
    await expect(releaseAllPageFiles([pageFiles(), second])).resolves.toBeUndefined();
    expect(deleteAsync).toHaveBeenCalledTimes(4);
    expect(deleteAsync).toHaveBeenCalledWith(SECOND_OUTPUT_URI, { idempotent: true });
  });

  it('resolves without touching the filesystem for an empty batch', async () => {
    await expect(releaseAllPageFiles([])).resolves.toBeUndefined();
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('releaseUris', () => {
  it('deletes every uri in the set idempotently', async () => {
    await releaseUris([SOURCE_URI, OUTPUT_URI, SECOND_SOURCE_URI]);
    expect(deleteAsync).toHaveBeenCalledTimes(3);
    expect(deleteAsync).toHaveBeenCalledWith(SOURCE_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(OUTPUT_URI, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(SECOND_SOURCE_URI, { idempotent: true });
  });

  it('swallows a rejected delete and still attempts the rest', async () => {
    silenceWarnings();
    deleteAsync.mockRejectedValueOnce(new Error('busy'));
    await expect(releaseUris([SOURCE_URI, OUTPUT_URI])).resolves.toBeUndefined();
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(deleteAsync).toHaveBeenCalledWith(OUTPUT_URI, { idempotent: true });
  });

  it('resolves without touching the filesystem for an empty set', async () => {
    await expect(releaseUris([])).resolves.toBeUndefined();
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});
