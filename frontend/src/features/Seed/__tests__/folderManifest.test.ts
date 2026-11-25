/* eslint-env jest */
/* global describe, test, expect */
import {
  buildFolderManifest,
  MAX_FOLDER_ENUMERATED_FILES,
  MAX_FOLDER_SELECTED_BYTES,
  selectFolderEntries,
  type FolderFileLike,
} from '../folderManifest';
import { MAX_SEED_DOCUMENT_BYTES } from '../readSeedDocument';

/** A stand-in for a browser File: only the metadata a manifest reads. */
type FakeFile = FolderFileLike;

function file(webkitRelativePath: string, size = 100): FakeFile {
  const name = webkitRelativePath.slice(webkitRelativePath.lastIndexOf('/') + 1);
  return { name, size, webkitRelativePath };
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
      subscriber_data: 0,
    });
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

describe('the files a folder holds that will not be sent (#3771)', () => {
  test('are kept by path and reason, in path order', () => {
    const manifest = manifestOf([
      ...VAULT,
      file('My Vault/.hidden.md'),
      file('My Vault/big.md', MAX_SEED_DOCUMENT_BYTES + 1),
      file('My Vault/export.json'),
    ]);
    expect(manifest.skippedFiles).toEqual([
      { path: '.hidden.md', reason: 'hidden' },
      { path: '.obsidian/app.json', reason: 'configuration' },
      { path: 'big.md', reason: 'too_large' },
      { path: 'cache/example.bin', reason: 'unsupported' },
      { path: 'export.json', reason: 'unsupported' },
    ]);
  });

  test('keep both spellings of a collided path, and a file from outside the folder', () => {
    const nfc = 'My Vault/Caf\u00e9.md';
    const nfd = 'My Vault/Cafe\u0301.md';
    const manifest = manifestOf([file(nfc), file(nfd), file('My Vault/a.md'), file('Other/b.md')]);
    expect(manifest.skippedFiles).toEqual([
      { path: 'Caf\u00e9.md', reason: 'collision' },
      { path: 'Caf\u00e9.md', reason: 'collision' },
      { path: 'Other/b.md', reason: 'unsafe_path' },
    ]);
  });

  test('every extension Creek refuses with a 415 is skipped as unsupported', () => {
    const refused = [
      '.json',
      '.jsonl',
      '.ndjson',
      '.tar',
      '.tgz',
      '.gz',
      '.bz2',
      '.xz',
      '.7z',
      '.rar',
      '.doc',
      '.xls',
      '.ppt',
    ];
    const manifest = manifestOf(refused.map((extension) => file(`My Vault/export${extension}`)));
    expect(manifest.notes).toEqual([]);
    expect(manifest.attachments).toEqual([]);
    expect(manifest.skipped.unsupported).toBe(refused.length);
  });

  test('a selection with attachments off leaves them out by name, as attachments_off', () => {
    const manifest = manifestOf(VAULT);
    expect(selectFolderEntries(manifest, false).leftOut).toEqual([
      { path: '.obsidian/app.json', reason: 'configuration' },
      { path: 'assets/diagram.png', reason: 'attachments_off' },
      { path: 'cache/example.bin', reason: 'unsupported' },
    ]);
    expect(selectFolderEntries(manifest, true).leftOut).toEqual([
      { path: '.obsidian/app.json', reason: 'configuration' },
      { path: 'cache/example.bin', reason: 'unsupported' },
    ]);
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

describe("a Substack export's stat and subscriber CSVs (#3798)", () => {
  const EXPORT = [
    file('export/posts.csv', 40),
    file('export/email_list.my-publication.csv', 900),
    file('export/posts/141234.my-post.html', 500),
    file('export/posts/141234.my-post.delivers.csv', 700),
    file('export/posts/141234.my-post.OPENS.CSV', 800),
    file('export/notes/budget.csv', 30),
    file('export/notes/essay.md', 20),
  ];
  const SUBSCRIBER_FILES = [
    { path: 'email_list.my-publication.csv', reason: 'subscriber_data' },
    { path: 'posts/141234.my-post.OPENS.CSV', reason: 'subscriber_data' },
    { path: 'posts/141234.my-post.delivers.csv', reason: 'subscriber_data' },
  ];

  test('are held back under their own reason, counted and kept by path', () => {
    const manifest = manifestOf(EXPORT);
    expect(manifest.skipped.subscriber_data).toBe(3);
    expect(manifest.skipped.unsupported).toBe(0);
    expect(manifest.skippedFiles).toEqual(SUBSCRIBER_FILES);
  });

  test('are never offered as attachments; posts.csv and an ordinary .csv still are', () => {
    const manifest = manifestOf(EXPORT);
    expect(manifest.attachments.map((entry) => entry.relativePath)).toEqual([
      'notes/budget.csv',
      'posts.csv',
      'posts/141234.my-post.html',
    ]);
  });

  test.each([true, false])('stay behind with attachments on: %s', (includeAttachments) => {
    const selection = selectFolderEntries(manifestOf(EXPORT), includeAttachments);
    const sent = selection.entries.map((entry) => entry.relativePath);
    for (const { path } of SUBSCRIBER_FILES) expect(sent).not.toContain(path);
    expect(selection.leftOut.filter((left) => left.reason === 'subscriber_data')).toEqual(
      SUBSCRIBER_FILES,
    );
    // Their bytes are no part of what the selection would send.
    expect(selection.bytes).toBe(includeAttachments ? 590 : 20);
  });

  test('an oversize stat file is still named for what it is, not for its size', () => {
    const manifest = manifestOf([
      file('export/posts/1.a.opens.csv', MAX_SEED_DOCUMENT_BYTES + 1),
      file('export/a.md'),
    ]);
    expect(manifest.skippedFiles).toEqual([
      { path: 'posts/1.a.opens.csv', reason: 'subscriber_data' },
    ]);
  });
});
