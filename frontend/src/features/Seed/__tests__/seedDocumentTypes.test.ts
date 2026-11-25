/* eslint-env jest */
/* global describe, test, expect */
import {
  isSeedableFilename,
  SEED_DOCUMENT_EXTENSIONS as PICKER_EXTENSIONS,
} from '../pickSeedDocuments';
import {
  SEED_ATTACHMENT_EXTENSIONS,
  SEED_DOCUMENT_EXTENSIONS,
  SEED_NOTE_EXTENSIONS,
  seedDocumentKind,
} from '../seedDocumentTypes';

/**
 * What Creek-Vault actually ingests through `POST /v1/uploads`, copied from its
 * source so the client list cannot drift from it quietly (#3553 R1-5).
 *
 * The upload route picks an ingestor with `route_to_ingestor`, which reads one
 * table and nothing else: `_EXTENSION_ROUTES` in `creek/ingest/gdrive.py:130-149`
 * (Creek-Vault@077ec033). An extension the table does not name falls through to
 * the `generic` ingestor, whose plain-text set is `creek/ingest/generic.py:46`.
 * A `.zip` leaves the single-document path for the archive fork
 * (`creek/ingest/archive.py:71`, `creek_mcp/tools/upload.py` `upload_tool`).
 *
 * Each disputed type was checked against Creek's real `upload_tool`, the
 * function behind `/v1/uploads`: `.markdown` is ingested by the markdown
 * ingestor; `.text` and `.log` by `generic`; `.heic` is refused with "generic
 * ingest produced no fragment from this file", so it is not offered.
 *
 * When Creek's table changes, change this table and the list together.
 */
const CREEK_ROUTED_EXTENSIONS = [
  '.md',
  '.markdown',
  '.docx',
  '.pdf',
  '.html',
  '.htm',
  '.txt',
  '.rtf',
  '.xlsx',
  '.csv',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.webp',
];
const CREEK_GENERIC_PLAIN_TEXT_EXTENSIONS = ['.txt', '.text', '.log'];
const CREEK_ARCHIVE_EXTENSIONS = ['.zip'];

/**
 * Refused by the table, accepted by content (#3797). `_EXTENSION_ROUTES` still
 * lists `.json` as a `_Refuse` (`creek/ingest/gdrive.py:150-154`,
 * Creek-Vault@61257733), but since Creek-Vault#2148 the upload route reads a
 * `.json`'s CONTENTS above that table (`creek_mcp/tools/upload.py`
 * `upload_tool`: `is_loose_json` then `detect_document_export_type`,
 * `creek/ingest/archive.py:610-646`). A ChatGPT `conversations.json`, a Claude
 * export or a Discord `messages.json` takes the archive path and answers like
 * an export `.zip`; any other `.json`, and a recognised export with nothing in
 * it, falls through to the table's refusal and answers `415
 * unsupported_source`. So `.json` is sendable, and the vault decides: the
 * device never reads a `.json` to guess. `.jsonl` and `.ndjson` have no such
 * fork and stay refused.
 */
const CREEK_CONTENT_ROUTED_EXTENSIONS = ['.json'];

/**
 * The extensions Creek's table refuses with `415 unsupported_source`, each a
 * `_Refuse` entry in `_EXTENSION_ROUTES` at `creek/ingest/gdrive.py:150-167`
 * (Creek-Vault@61257733) -- `.zip` excepted, which the upload route forks to
 * its archive path before the table is read. Restated in Creek's own order so a
 * diff against that table reads line for line (#3771).
 *
 * `.json` stays in this restated table on purpose, because it is still in
 * Creek's: see {@link CREEK_CONTENT_ROUTED_EXTENSIONS} for why it is sendable
 * all the same.
 */
const CREEK_415_EXTENSIONS = [
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

/**
 * The 415 rows nothing above the table rescues: every one of them but `.json`.
 * These never leave the device.
 */
const CREEK_ALWAYS_415_EXTENSIONS = CREEK_415_EXTENSIONS.filter(
  (extension) => !CREEK_CONTENT_ROUTED_EXTENSIONS.includes(extension),
);

/**
 * Extensions Creek refuses whatever the file holds, or that no ingestor reads.
 * `.json` is absent: its contents decide (#3797).
 */
const CREEK_REFUSED_EXTENSIONS = [
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
  '.heic',
];

const creekIngestable = new Set([
  ...CREEK_ROUTED_EXTENSIONS,
  ...CREEK_GENERIC_PLAIN_TEXT_EXTENSIONS,
  ...CREEK_ARCHIVE_EXTENSIONS,
  ...CREEK_CONTENT_ROUTED_EXTENSIONS,
]);

describe('the one list of types a seed can carry', () => {
  test('is exactly what Creek ingests through /v1/uploads', () => {
    expect([...SEED_DOCUMENT_EXTENSIONS].sort()).toEqual([...creekIngestable].sort());
  });

  test('names each type once', () => {
    expect(new Set(SEED_DOCUMENT_EXTENSIONS).size).toBe(SEED_DOCUMENT_EXTENSIONS.length);
  });

  test('offers nothing Creek refuses or cannot read', () => {
    for (const extension of CREEK_REFUSED_EXTENSIONS) {
      expect(SEED_DOCUMENT_EXTENSIONS).not.toContain(extension);
    }
  });

  test('is the list the individual picker checks against', () => {
    expect(PICKER_EXTENSIONS).toBe(SEED_DOCUMENT_EXTENSIONS);
  });

  test('splits into notes and attachments with no overlap and nothing left over', () => {
    const notes = new Set(SEED_NOTE_EXTENSIONS);
    for (const extension of SEED_ATTACHMENT_EXTENSIONS) {
      expect(notes.has(extension)).toBe(false);
    }
    expect([...SEED_NOTE_EXTENSIONS, ...SEED_ATTACHMENT_EXTENSIONS].sort()).toEqual(
      [...SEED_DOCUMENT_EXTENSIONS].sort(),
    );
  });

  test('counts Markdown and plain text as notes', () => {
    expect([...SEED_NOTE_EXTENSIONS].sort()).toEqual(['.markdown', '.md', '.text', '.txt']);
  });
});

describe('a type Creek refuses with a 415 never leaves the device (#3771)', () => {
  test('is refused by both the picker and a folder', () => {
    for (const extension of CREEK_ALWAYS_415_EXTENSIONS) {
      expect(seedDocumentKind(`export${extension}`)).toBeNull();
      expect(isSeedableFilename(`export${extension}`)).toBe(false);
    }
  });

  test('is among the refused types this list is held against', () => {
    for (const extension of CREEK_ALWAYS_415_EXTENSIONS) {
      expect(CREEK_REFUSED_EXTENSIONS).toContain(extension);
    }
  });

  test('covers every 415 row but the one whose contents decide', () => {
    expect(CREEK_415_EXTENSIONS).toContain('.json');
    expect(CREEK_ALWAYS_415_EXTENSIONS).toEqual(
      CREEK_415_EXTENSIONS.filter((extension) => extension !== '.json'),
    );
  });
});

describe('a .json is sent for the vault to decide (#3797)', () => {
  test('is sendable from the picker and from a folder, as an attachment', () => {
    expect(SEED_ATTACHMENT_EXTENSIONS).toContain('.json');
    expect(SEED_NOTE_EXTENSIONS).not.toContain('.json');
    expect(seedDocumentKind('conversations.json')).toBe('attachment');
    expect(seedDocumentKind('messages.JSON')).toBe('attachment');
    expect(isSeedableFilename('conversations.json')).toBe(true);
  });

  test.each(['.jsonl', '.ndjson'])('%s stays unsupported', (extension) => {
    expect(SEED_DOCUMENT_EXTENSIONS).not.toContain(extension);
    expect(seedDocumentKind(`export${extension}`)).toBeNull();
    expect(isSeedableFilename(`export${extension}`)).toBe(false);
  });
});

describe('seedDocumentKind', () => {
  test('reads a note, an attachment and an unknown type', () => {
    expect(seedDocumentKind('Index.md')).toBe('note');
    expect(seedDocumentKind('diagram.png')).toBe('attachment');
    expect(seedDocumentKind('example.bin')).toBeNull();
  });

  test('reads the extension case-insensitively, from the last dot', () => {
    expect(seedDocumentKind('NOTES.MD')).toBe('note');
    expect(seedDocumentKind('scan.final.TIFF')).toBe('attachment');
    expect(seedDocumentKind('archive.md.bin')).toBeNull();
  });

  test('gives a name with no extension no kind', () => {
    expect(seedDocumentKind('README')).toBeNull();
    expect(seedDocumentKind('md')).toBeNull();
  });
});
