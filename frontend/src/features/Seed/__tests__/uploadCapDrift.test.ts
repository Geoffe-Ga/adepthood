/* eslint-env jest */
/* global describe, test, expect */
import * as fs from 'fs';
import * as path from 'path';

import { MAX_SEED_DOCUMENT_BYTES, MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';

/**
 * The endpoint's cap lives in Python and is enforced there; the client mirrors
 * it so a person is told their file is too large instead of spending a doomed
 * upload. A mirrored number is only honest while something fails when it
 * drifts, which is what this reads the backend source to do.
 */
const BACKEND_SCHEMA = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'backend',
  'src',
  'schemas',
  'journal_upload.py',
);

const MAX_UPLOAD_BYTES = /^MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024$/m;
const BYTES_PER_MB = 1024 * 1024;

function backendCapInBytes(): number {
  const source = fs.readFileSync(BACKEND_SCHEMA, 'utf-8');
  const match = MAX_UPLOAD_BYTES.exec(source);
  if (match === null) {
    throw new Error(`MAX_UPLOAD_BYTES not found in ${BACKEND_SCHEMA}`);
  }
  return Number(match[1]) * BYTES_PER_MB;
}

describe('the client-side upload cap', () => {
  test('is exactly the cap the endpoint enforces', () => {
    expect(MAX_SEED_DOCUMENT_BYTES).toBe(backendCapInBytes());
  });

  test('is named to the user in the same number it gates on', () => {
    expect(MAX_SEED_DOCUMENT_LABEL).toBe(`${MAX_SEED_DOCUMENT_BYTES / BYTES_PER_MB} MB`);
  });
});
