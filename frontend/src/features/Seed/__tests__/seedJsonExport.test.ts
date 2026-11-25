/* eslint-env jest */
/* global describe, test, expect */
import { MANAGED_SEED_DOCUMENT_LABEL, MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
import { SEED_STATUS_LINES } from '../seedCopy';
import {
  isJsonExportName,
  SEED_JSON_EXPORT_NOTE,
  SEED_JSON_STATUS_LINES,
  seedStatusLine,
} from '../seedJsonExport';
import type { SeedItemStatus } from '../seedRun';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

/** The statuses a `.json` row says differently from every other file. */
const JSON_STATUSES: readonly SeedItemStatus[] = [
  'unsupported_source',
  'too_large',
  'managed_too_large',
];

/** Every line this module adds. */
const NEW_COPY: readonly string[] = [
  SEED_JSON_EXPORT_NOTE,
  ...JSON_STATUSES.map((status) => SEED_JSON_STATUS_LINES[status] ?? ''),
];

describe('isJsonExportName', () => {
  test('reads the extension case-insensitively, from a name or a folder path', () => {
    expect(isJsonExportName('conversations.json')).toBe(true);
    expect(isJsonExportName('Discord/messages/c123/messages.JSON')).toBe(true);
  });

  test.each(['export.jsonl', 'export.ndjson', 'notes.md', 'json', 'export.json.zip'])(
    '%s is not one',
    (name) => {
      expect(isJsonExportName(name)).toBe(false);
    },
  );
});

describe('what a .json row says (#3797)', () => {
  test('exactly three outcomes are worded for a .json', () => {
    expect(Object.keys(SEED_JSON_STATUS_LINES).sort()).toEqual([...JSON_STATUSES].sort());
  });

  test.each(JSON_STATUSES)('%s reads differently for a .json than for any other file', (status) => {
    const line = seedStatusLine({ name: 'conversations.json', status });

    expect(line).toBe(SEED_JSON_STATUS_LINES[status]);
    expect(line).not.toBe(SEED_STATUS_LINES[status]);
    expect(seedStatusLine({ name: 'notes.pdf', status })).toBe(SEED_STATUS_LINES[status]);
  });

  test('every other outcome reads the same for a .json as for any file', () => {
    for (const status of ['ingested', 'queued', 'failed', 'attachments_off'] as const) {
      expect(seedStatusLine({ name: 'conversations.json', status })).toBe(
        SEED_STATUS_LINES[status],
      );
    }
  });

  test('a .json the vault turns away is skipped, named as not a conversation export', () => {
    // True before and after the vault learns to read a loose export: until
    // then it reads none, and the `.zip` goes either way.
    const line = seedStatusLine({ name: 'package.json', status: 'unsupported_source' });

    expect(line.startsWith('Skipped · ')).toBe(true);
    expect(line).toContain('not a conversation export your Corpus reads');
    expect(line).toContain('nothing was stored');
    expect(line).toContain('.zip');
  });

  test('a .json past the cap names the limit and offers the .zip instead', () => {
    const line = seedStatusLine({ name: 'conversations.json', status: 'too_large' });

    expect(line.startsWith('Skipped · ')).toBe(true);
    expect(line).toContain(MAX_SEED_DOCUMENT_LABEL);
    expect(line).toContain('never sent');
    expect(line).toContain("send the export's .zip instead");
  });

  test('a .json too large for a managed Corpus names its limit and offers the .zip', () => {
    const line = seedStatusLine({ name: 'conversations.json', status: 'managed_too_large' });

    expect(line).toContain(MANAGED_SEED_DOCUMENT_LABEL);
    expect(line).toContain('nothing was stored');
    expect(line).toContain("the export's .zip");
  });
});

describe('the new lines', () => {
  test('the note names the three exports and both ways they come in', () => {
    for (const word of ['ChatGPT', 'Claude', 'Discord', '.json', '.zip']) {
      expect(SEED_JSON_EXPORT_NOTE).toContain(word);
    }
  });

  test('say "your Corpus", never "vault" or "Creek" (epic #3802)', () => {
    for (const line of NEW_COPY) {
      expect(line).not.toMatch(/vault|creek/i);
    }
  });

  test('neither rank nor shame', () => {
    for (const line of NEW_COPY) {
      expect(line).not.toBe('');
      expect(ranksOrShames(line)).toBe(false);
    }
  });
});
