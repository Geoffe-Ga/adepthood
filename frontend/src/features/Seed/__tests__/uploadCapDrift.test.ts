/* eslint-env jest */
/* global describe, test, expect */
import { MAX_SEED_DOCUMENT_BYTES, MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The endpoint's cap lives in Python and is enforced there; the client mirrors
 * it so a person is told their file is too large instead of spending a doomed
 * upload. A mirrored number is only honest while something fails when it
 * drifts, which is what this reads the backend source to do.
 *
 * The read goes through `@/testing/backendSource`, which is what makes backend
 * CI run this file on the change that would break it.
 */
const BACKEND_SCHEMA = ['src', 'schemas', 'journal_upload.py'];

const MAX_UPLOAD_BYTES = /^MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024$/m;
const BYTES_PER_MB = 1024 * 1024;

function backendCapInBytes(): number {
  const match = MAX_UPLOAD_BYTES.exec(readBackendSource(...BACKEND_SCHEMA));
  if (match === null) {
    throw new Error(`MAX_UPLOAD_BYTES not found in backend/${BACKEND_SCHEMA.join('/')}`);
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
