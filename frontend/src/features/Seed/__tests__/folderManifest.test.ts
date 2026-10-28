/* eslint-env jest */
/* global describe, test, expect, jest */
import {
  buildFolderManifest,
  MAX_FOLDER_ENUMERATED_FILES,
  MAX_FOLDER_SELECTED_BYTES,
  selectFolderEntries,
  type FolderFileLike,
} from '../folderManifest';
import { MAX_SEED_DOCUMENT_BYTES } from '../readSeedDocument';

/** A stand-in for a browser File whose content readers fail the test if touched. */
interface FakeFile extends FolderFileLike {
  arrayBuffer: jest.Mock;
  text: jest.Mock;
}

function file(webkitRelativePath: string, size = 100): FakeFile {
  const name = webkitRelativePath.slice(webkitRelativePath.lastIndexOf('/') + 1);
  return { name, size, webkitRelativePath, arrayBuffer: jest.fn(), text: jest.fn() };
}

function manifestOf(files: FakeFile[]) {
  const result = buildFolderManifest(files);
  if (result.kind !== 'manifest') throw new Error(`expected a manifest, got ${result.kind}`);
  return result.manifest;
}

const VAULT = [
  file('My Vault/Work/Index.md', 10),
  file('My Vault/Home/Index.md', 20),
  file('My Vault/assets/diagram.png', 300),
  file('My Vault/.obsidian/app.json', 5),
  file('My Vault/cache/example.bin', 7),
];

describe('buildFolderManifest', () => {
  test('keeps every nested note distinct by its path under the chosen folder', () => {
    const manifest = manifestOf(VAULT);
    expect(manifest.rootName).toBe('My Vault');
    expect(manifest.notes.map((entry) => entry.relativePath)).toEqual([
      'Home/Index.md',
      'Work/Index.md',
    ]);
    expect(manifest.notes.map((entry) => entry.name)).toEqual(['Index.md', 'Index.md']);
    expect(manifest.notes.map((entry) => entry.kind)).toEqual(['note', 'note']);
  });

  test('lists a supported attachment apart from the notes, with its handle', () => {
    const manifest = manifestOf(VAULT);
    expect(manifest.attachments).toEqual([
      expect.objectContaining({
        relativePath: 'assets/diagram.png',
        kind: 'attachment',
        size: 300,
        file: VAULT[2],
      }),
    ]);
  });

  test('counts configuration and unsupported files instead of dropping them', () => {
    const manifest = manifestOf(VAULT);
    expect(manifest.enumerated).toBe(5);
    expect(manifest.skipped).toEqual({
      configuration: 1,
      hidden: 0,
      unsupported: 1,
      unsafe_path: 0,
      too_large: 0,
      collision: 0,
    });
  });

  test('never opens a file, eligible or excluded', () => {
    manifestOf(VAULT);
    for (const handle of VAULT) {
      expect(handle.arrayBuffer).not.toHaveBeenCalled();
      expect(handle.text).not.toHaveBeenCalled();
    }
  });

  test('is deterministic whatever order the browser lists files in', () => {
    const forward = manifestOf(VAULT);
    const backward = manifestOf([...VAULT].reverse());
    expect(backward.notes.map((entry) => entry.relativePath)).toEqual(
      forward.notes.map((entry) => entry.relativePath),
    );
  });

  test.each([
    ['.obsidian', 'My Vault/.obsidian/plugins/example/data.json'],
    ['.git', 'My Vault/.git/HEAD.md'],
    ['.trash', 'My Vault/.trash/old.md'],
    ['__MACOSX', 'My Vault/__MACOSX/Work/._Index.md'],
  ])('excludes %s as configuration, even a note inside it', (_label, path) => {
    expect(manifestOf([file(path), file('My Vault/a.md')]).skipped.configuration).toBe(1);
  });

  test('excludes hidden files and hidden folders', () => {
    const manifest = manifestOf([
      file('My Vault/.hidden.md'),
      file('My Vault/.drafts/note.md'),
      file('My Vault/a.md'),
    ]);
    expect(manifest.skipped.hidden).toBe(2);
    expect(manifest.notes).toHaveLength(1);
  });

  test('marks a document past the per-file cap too large, and never offers it', () => {
    const manifest = manifestOf([
      file('My Vault/huge.pdf', MAX_SEED_DOCUMENT_BYTES + 1),
      file('My Vault/a.md'),
    ]);
    expect(manifest.skipped.too_large).toBe(1);
    expect(manifest.attachments).toEqual([]);
  });

  test('refuses a name the server would refuse rather than flattening it', () => {
    const manifest = manifestOf([file('My Vault/Work/a..b.md'), file('My Vault/ok.md')]);
    expect(manifest.skipped.unsafe_path).toBe(1);
  });

  test('refuses a file that sits outside the chosen folder', () => {
    const manifest = manifestOf([
      file('loose.md'),
      file('Other/b.md'),
      file('My Vault/ok.md'),
      file('My Vault/also.md'),
    ]);
    expect(manifest.skipped.unsafe_path).toBe(2);
    expect(manifest.rootName).toBe('My Vault');
  });

  test('never merges two spellings of one path; both are held back', () => {
    const manifest = manifestOf([
      file('My Vault/Café.md'),
      file('My Vault/Café.md'),
      file('My Vault/ok.md'),
    ]);
    expect(manifest.skipped.collision).toBe(2);
    expect(manifest.notes.map((entry) => entry.relativePath)).toEqual(['ok.md']);
  });

  test('normalizes a path and its name to NFC', () => {
    const [entry] = manifestOf([file('Résumé/Café.md')]).notes;
    expect(entry?.relativePath).toBe('Café.md');
    expect(entry?.name).toBe('Café.md');
  });

  test('answers an empty selection as empty', () => {
    expect(buildFolderManifest([])).toEqual({ kind: 'empty' });
  });

  test('refuses a folder with more files than the named bound', () => {
    const many = Array.from({ length: MAX_FOLDER_ENUMERATED_FILES + 1 }, (_value, index) =>
      file(`My Vault/${index}.md`),
    );
    expect(buildFolderManifest(many)).toEqual({
      kind: 'too_many',
      enumerated: MAX_FOLDER_ENUMERATED_FILES + 1,
    });
  });

  test('accepts a folder at exactly the bound', () => {
    const many = Array.from({ length: MAX_FOLDER_ENUMERATED_FILES }, (_value, index) =>
      file(`My Vault/${index}.md`),
    );
    expect(buildFolderManifest(many).kind).toBe('manifest');
  });
});

describe('selectFolderEntries', () => {
  test('selects only the notes until attachments are asked for', () => {
    const manifest = manifestOf(VAULT);
    const notesOnly = selectFolderEntries(manifest, false);
    expect(notesOnly.entries.map((entry) => entry.relativePath)).toEqual([
      'Home/Index.md',
      'Work/Index.md',
    ]);
    expect(notesOnly.bytes).toBe(30);
    expect(notesOnly.withinBounds).toBe(true);
  });

  test('adds the attachments, in path order, when asked', () => {
    const selection = selectFolderEntries(manifestOf(VAULT), true);
    expect(selection.entries.map((entry) => entry.relativePath)).toEqual([
      'Home/Index.md',
      'Work/Index.md',
      'assets/diagram.png',
    ]);
    expect(selection.bytes).toBe(330);
  });

  test('says when the selection is past the aggregate byte bound', () => {
    const per = MAX_SEED_DOCUMENT_BYTES;
    const count = Math.floor(MAX_FOLDER_SELECTED_BYTES / per) + 1;
    const files = Array.from({ length: count }, (_value, index) =>
      file(`My Vault/${index}.pdf`, per),
    );
    const manifest = manifestOf([...files, file('My Vault/a.md', 1)]);
    expect(selectFolderEntries(manifest, false).withinBounds).toBe(true);
    expect(selectFolderEntries(manifest, true).withinBounds).toBe(false);
  });

  test('names an empty selection as one nothing can start', () => {
    const manifest = manifestOf([file('My Vault/diagram.png')]);
    const selection = selectFolderEntries(manifest, false);
    expect(selection.entries).toEqual([]);
    expect(selection.withinBounds).toBe(true);
  });
});
