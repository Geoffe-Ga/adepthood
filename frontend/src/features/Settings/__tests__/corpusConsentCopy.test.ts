/* eslint-env jest */
/* global describe, test, expect */
import * as fs from 'fs';
import * as path from 'path';

import {
  CORPUS_CONSENT_COPY_ENTRIES,
  CORPUS_SOURCE_COPY,
  SOURCES_ADEPTHOOD_SORTS,
  consentStatusLine,
  sourceCopy,
} from '../corpusConsentCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { backendPythonFiles, readBackendSource } from '@/testing/backendSource';

/**
 * What the consent screen is allowed to say, held to what the code does.
 *
 * A consent screen is the one surface where a sentence that has drifted from
 * the implementation is not a typo but a false statement about somebody's
 * writing. So the promises are read back out of the backend that keeps them:
 * the default is off because a Python constant says so, and only the sources
 * something actually sorts are offered as a decision.
 *
 * The reads go through `@/testing/backendSource`, which is what makes backend
 * CI run this file on the change that would break it -- a source gaining its
 * first writer is a backend-only diff, and this test going red only afterwards
 * is how it once turned `main` red.
 */

const CONSENT_SERVICE = ['src', 'services', 'corpus_consent.py'];
const SOURCE_ENUM_MODULE = path.join('models', 'corpus_fragment.py');

const DEFAULT_CONSTANT = /^CONSENT_GRANTED_BY_DEFAULT:\s*Final\[bool]\s*=\s*(True|False)$/m;
const NAMED_SOURCE = /CorpusSource\.([A-Z_]+)/g;

/**
 * The sources some backend module names when it writes a fragment.
 *
 * The enum's own module is skipped: declaring a member is not collecting
 * anything under it, and counting the declaration would make every source look
 * live the moment it was named.
 */
function sourcesWithAWriter(): string[] {
  const named = new Set<string>();
  for (const file of backendPythonFiles('src')) {
    if (file.endsWith(SOURCE_ENUM_MODULE)) continue;
    for (const match of fs.readFileSync(file, 'utf-8').matchAll(NAMED_SOURCE)) {
      named.add(String(match[1]).toLowerCase());
    }
  }
  return [...named].sort();
}

function servedSources(): string[] {
  const schema = JSON.parse(readBackendSource('openapi.json')) as {
    components: { schemas: Record<string, { enum?: string[] }> };
  };
  return schema.components.schemas['CorpusSource']?.enum ?? [];
}

describe('the corpus-consent copy, against what the backend actually does', () => {
  test('says the corpus is off until it is turned on because the server has it off', () => {
    const match = DEFAULT_CONSTANT.exec(readBackendSource(...CONSENT_SERVICE));

    expect(match?.[1]).toBe('False');
  });

  test('offers a decision only about the sources something writes fragments for', () => {
    expect([...SOURCES_ADEPTHOOD_SORTS].sort()).toEqual(sourcesWithAWriter());
  });

  test('has copy for every source the API serves, so no row shows a raw token', () => {
    for (const source of servedSources()) {
      expect(Object.keys(CORPUS_SOURCE_COPY)).toContain(source);
    }
  });

  test('names an unknown source rather than rendering nothing for it', () => {
    const copy = sourceCopy('something-new');

    expect(copy.label.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
  });
});

describe('the corpus-consent copy, as an invitation', () => {
  test('exposes its lines to sweep', () => {
    expect(CORPUS_CONSENT_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  test('no line ranks, shames, or pressures the reader into agreeing', () => {
    for (const entry of CORPUS_CONSENT_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  test('no line claims a protection this repository has not built', () => {
    for (const entry of CORPUS_CONSENT_COPY_ENTRIES) {
      expect(entry).not.toMatch(/anonym/i);
      expect(entry).not.toMatch(/encrypt/i);
      expect(entry).not.toMatch(/\bprivate\b/i);
    }
  });

  test('says both consequences of agreeing before anything is agreed to', () => {
    const said = CORPUS_CONSENT_COPY_ENTRIES.join(' ');

    expect(said).toMatch(/sent once/i);
    expect(said).toMatch(/deletes/i);
  });
});

describe('consentStatusLine', () => {
  test('separates a question never asked from an answer of no', () => {
    const unasked = consentStatusLine({ source: 'journal', granted: false, decided_at: null });
    const declined = consentStatusLine({
      source: 'journal',
      granted: false,
      decided_at: '2026-08-18T09:00:00Z',
    });

    expect(unasked).not.toBe(declined);
    expect(declined).toMatch(/2026/);
  });

  test('dates a decision to agree', () => {
    const line = consentStatusLine({
      source: 'journal',
      granted: true,
      decided_at: '2026-08-18T09:00:00Z',
    });

    expect(line).toMatch(/2026/);
    expect(line).toMatch(/^On\b/);
  });

  test('says the plain state when a decision carries no date', () => {
    const line = consentStatusLine({ source: 'journal', granted: true, decided_at: null });

    expect(line).toMatch(/^On\b/);
    expect(line).not.toMatch(/Invalid/i);
  });
});
