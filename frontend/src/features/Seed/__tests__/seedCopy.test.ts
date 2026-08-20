/* eslint-env jest */
/* global describe, test, expect */
import { MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
import { SEED_STATUS_LINES, seedSummaryLine } from '../seedCopy';
import type { SeedItemStatus } from '../seedRun';

const EVERY_STATUS: readonly SeedItemStatus[] = [
  'queued',
  'uploading',
  'ingested',
  'vault_unavailable',
  'capability_unsupported',
  'degraded',
  'unsupported_format',
  'too_large',
  'unreadable',
  'failed',
];

describe('what each outcome says', () => {
  test('every status has its own line', () => {
    const lines = EVERY_STATUS.map((status) => SEED_STATUS_LINES[status]);

    expect(lines.filter(Boolean)).toHaveLength(EVERY_STATUS.length);
    expect(new Set(lines).size).toBe(EVERY_STATUS.length);
  });

  test('a vault that cannot take files yet does not read as a failure', () => {
    const line = SEED_STATUS_LINES.capability_unsupported;

    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line).not.toBe(SEED_STATUS_LINES.degraded);
    expect(line.toLowerCase()).toContain('yet');
  });

  test('the unsupported line does not pin the gap on the vault alone', () => {
    // One status covers two versions: a vault too old to take files, and a
    // vault offering an upload route this app cannot speak yet. Nothing here
    // can tell which, so "update your vault" would be advice that sometimes
    // cannot work — and the person following it has no way to know when.
    expect(SEED_STATUS_LINES.capability_unsupported).toContain('Adepthood');
  });

  test('the size refusal names the limit', () => {
    expect(SEED_STATUS_LINES.too_large).toContain(MAX_SEED_DOCUMENT_LABEL);
  });
});

describe('the run summary', () => {
  test('says nothing before anything is picked', () => {
    expect(seedSummaryLine({ total: 0, ingested: 0, waiting: 0, refused: 0 })).toBeNull();
  });

  test('counts what is still going', () => {
    expect(seedSummaryLine({ total: 3, ingested: 1, waiting: 2, refused: 0 })).toContain('3');
  });

  test('names what landed and what did not, without dressing it up', () => {
    const line = seedSummaryLine({ total: 3, ingested: 2, waiting: 0, refused: 1 });

    expect(line).toContain('2');
    expect(line).toContain('1');
  });
});
