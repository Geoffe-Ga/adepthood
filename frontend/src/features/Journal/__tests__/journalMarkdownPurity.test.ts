/* eslint-env jest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown, serializeJournalMarkdown } from '../journalMarkdown';

/** Every module of the Markdown model; all four must stay renderer-agnostic. */
const MODEL_MODULES = [
  'journalMarkdown.ts',
  'journalMarkdownTypes.ts',
  'journalMarkdownLines.ts',
  'journalMarkdownInline.ts',
  'journalMarkdownCaret.ts',
  'codePoints.ts',
];

function moduleSource(name: string): string {
  return readFileSync(join(__dirname, '..', name), 'utf8');
}

describe('the Markdown model stays free of the renderer', () => {
  it.each(MODEL_MODULES)('%s imports neither React nor React Native', (name) => {
    const source = moduleSource(name);
    expect(source).not.toMatch(/from\s+'react'/u);
    expect(source).not.toMatch(/from\s+'react-native'/u);
    expect(source).not.toMatch(/require\(['"]react(-native)?['"]\)/u);
  });

  it.each(MODEL_MODULES)('%s imports only from inside this model', (name) => {
    const imports = [...moduleSource(name).matchAll(/from\s+'([^']+)'/gu)].map(
      (match) => match[1]!,
    );
    for (const specifier of imports) {
      expect(specifier.startsWith('./')).toBe(true);
    }
  });

  it('parses and serializes with no host environment at all', () => {
    // Edit mode and read mode share this module, and the editor runs before any
    // renderer is mounted; a stray React import would make it unusable there.
    expect(serializeJournalMarkdown(parseJournalMarkdown('- one\n> two'))).toBe('- one\n> two');
  });
});
