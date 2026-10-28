/* eslint-env jest */
/* global describe, test, expect */
import { MAX_FOLDER_ENUMERATED_FILES } from '../folderManifest';
import {
  folderAttachmentsLabel,
  folderBytesLabel,
  folderMoreLine,
  folderNotesLine,
  folderSelectedSizeLine,
  folderSkippedLine,
  folderStartBlocker,
  SEED_FOLDER_EMPTY_NOTICE,
  SEED_FOLDER_NAMESPACE_INVALID,
  SEED_FOLDER_NOTHING_SELECTED,
  SEED_FOLDER_OVER_BYTES,
  SEED_FOLDER_TOO_MANY_NOTICE,
} from '../seedFolderCopy';

const NO_SKIPS = {
  configuration: 0,
  hidden: 0,
  unsupported: 0,
  unsafe_path: 0,
  too_large: 0,
  collision: 0,
};

describe('folder review copy', () => {
  test('counts selected notes in the singular and plural', () => {
    expect(folderNotesLine(1)).toBe('1 note selected');
    expect(folderNotesLine(2)).toBe('2 notes selected');
    expect(folderNotesLine(0)).toBe('No notes in this folder');
  });

  test('offers the attachments as a choice, by count', () => {
    expect(folderAttachmentsLabel(1)).toBe(
      'Also bring in 1 attachment (images, PDFs and other documents)',
    );
    expect(folderAttachmentsLabel(3)).toBe(
      'Also bring in 3 attachments (images, PDFs and other documents)',
    );
  });

  test('says nothing about skipped files when none were', () => {
    expect(folderSkippedLine(NO_SKIPS)).toBeNull();
  });

  test('names each reason a file was left out, without naming the file', () => {
    expect(
      folderSkippedLine({
        ...NO_SKIPS,
        configuration: 3,
        hidden: 1,
        unsupported: 2,
        unsafe_path: 1,
        too_large: 1,
        collision: 2,
      }),
    ).toBe(
      'Left out 10 files: 3 app settings, 1 hidden, 2 of a kind nothing here reads, ' +
        '1 with a name that can’t be sent, 1 larger than 10 MB, ' +
        '2 spelled two ways that would overwrite each other.',
    );
  });

  test('sizes a selection in KB below a megabyte and MB above it', () => {
    expect(folderBytesLabel(0)).toBe('0 KB');
    expect(folderBytesLabel(1536)).toBe('2 KB');
    expect(folderBytesLabel(5 * 1024 * 1024 + 1024 * 512)).toBe('5.5 MB');
    expect(folderSelectedSizeLine(2048)).toBe('2 KB in all');
  });

  test('says how many paths are not listed', () => {
    expect(folderMoreLine(0)).toBeNull();
    expect(folderMoreLine(12)).toBe('…and 12 more');
  });

  test('names a folder past the file bound with the bound itself', () => {
    expect(SEED_FOLDER_TOO_MANY_NOTICE).toContain(MAX_FOLDER_ENUMERATED_FILES.toLocaleString());
    expect(SEED_FOLDER_EMPTY_NOTICE).toMatch(/empty/);
    expect(SEED_FOLDER_OVER_BYTES).toContain('250 MB');
  });
});

describe('folderStartBlocker', () => {
  test('is null when the import can start', () => {
    expect(folderStartBlocker({ count: 2, withinBounds: true, namespaceValid: true })).toBeNull();
  });

  test('names the first thing in the way', () => {
    expect(folderStartBlocker({ count: 0, withinBounds: true, namespaceValid: true })).toBe(
      SEED_FOLDER_NOTHING_SELECTED,
    );
    expect(folderStartBlocker({ count: 2, withinBounds: false, namespaceValid: true })).toBe(
      SEED_FOLDER_OVER_BYTES,
    );
    expect(folderStartBlocker({ count: 2, withinBounds: true, namespaceValid: false })).toBe(
      SEED_FOLDER_NAMESPACE_INVALID,
    );
  });
});
