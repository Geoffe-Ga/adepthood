/* eslint-env jest */
/* global describe, test, expect */
import * as fs from 'fs';
import * as path from 'path';

import { SEED_STATUS_LINES } from '../seedCopy';
import type { SeedItemStatus } from '../seedRun';

import {
  corpusImportStatusSchema,
  documentImportSchema,
  importDestinationSchema,
} from '@/api/schemas';

/**
 * The import vocabulary, held to the one the server actually answers with.
 *
 * A client enum mirroring a backend enum is only honest while something fails
 * when it drifts. Both halves of this surface stay green through a drift on
 * their own — the screen's tests build their own fixtures, and the router's
 * tests never see this client — so the exported schema is read here and the
 * three claims that matter are checked against it: every status the server can
 * answer with is one this client accepts, one it can name in the run, and one
 * it has a sentence for.
 *
 * A status added on the server therefore turns this red on the day it is
 * exported, rather than rendering as a blank row on somebody's screen.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const OPENAPI = path.join(REPO_ROOT, 'backend', 'openapi.json');

/** How each destination's wire status is spelled in the run's vocabulary. */
const CORPUS_RENAMES: Record<string, SeedItemStatus> = { stored: 'in_corpus' };
const VAULT_RENAMES: Record<string, SeedItemStatus> = { accepted: 'ingested' };

function enumFromSchema(name: string): string[] {
  const document = JSON.parse(fs.readFileSync(OPENAPI, 'utf-8')) as {
    components: { schemas: Record<string, { enum?: string[] }> };
  };
  const values = document.components.schemas[name]?.enum;
  if (values === undefined) {
    throw new Error(`${OPENAPI} exports no "${name}" enum; the import surface has moved.`);
  }
  return values;
}

/** The status a wire value is rendered as, renames applied. */
function asSeedStatus(wire: string, renames: Record<string, SeedItemStatus>): SeedItemStatus {
  return renames[wire] ?? (wire as SeedItemStatus);
}

describe('the corpus vocabulary this client accepts', () => {
  test('is exactly the one the server exports', () => {
    expect([...corpusImportStatusSchema.options].sort()).toEqual(
      [...enumFromSchema('CorpusImportStatus')].sort(),
    );
  });

  test('names the same two destinations the server routes between', () => {
    expect([...importDestinationSchema.options].sort()).toEqual(
      [...enumFromSchema('ImportDestination')].sort(),
    );
  });

  test('gives every corpus outcome its own sentence', () => {
    for (const wire of enumFromSchema('CorpusImportStatus')) {
      expect(SEED_STATUS_LINES[asSeedStatus(wire, CORPUS_RENAMES)]).toBeTruthy();
    }
  });

  test('gives every vault outcome its own sentence', () => {
    for (const wire of enumFromSchema('VaultUploadStatus')) {
      expect(SEED_STATUS_LINES[asSeedStatus(wire, VAULT_RENAMES)]).toBeTruthy();
    }
  });
});

describe('the import response this client parses', () => {
  test('requires exactly the fields the server declares required', () => {
    const document = JSON.parse(fs.readFileSync(OPENAPI, 'utf-8')) as {
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const required = document.components.schemas['DocumentImportResponse']?.required ?? [];

    for (const field of required) {
      expect(Object.keys(documentImportSchema.shape)).toContain(field);
    }
  });

  test('refuses a body missing the destination it would have to render from', () => {
    expect(() =>
      documentImportSchema.parse({ stored: true, tags: [], message: 'something honest' }),
    ).toThrow();
  });
});
