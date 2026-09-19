/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { utf16ToCodePoint } from '../codePoints';
import {
  parseJournalMarkdown,
  serializeJournalMarkdown,
  sourceToUtf16,
  utf16ToSource,
} from '../journalMarkdown';

/**
 * Bodies the client model must carry through parse → serialize untouched.
 *
 * Frozen, and holding STRINGS rather than parsed documents, so the deliberate
 * mutation in "serializes only from the source stream" cannot leak into any
 * other case.
 *
 * Note: this is a CLIENT-MODEL corpus. `sanitize_user_text` on the backend
 * (backend/src/routers/journal.py -> backend/src/utils/text_sanitize.py) NFC
 * normalises and strips zero-width characters on save, so an end-to-end round
 * trip over the combining-mark and ZWJ entries below would be a false red on
 * deliberate security policy, not a bug.
 */
const CORPUS: readonly string[] = Object.freeze([
  '',
  '\n',
  '\n\n\n',
  '***',
  'a **unclosed',
  'a *b _c*',
  'a \\*x\\* b',
  'éclair *bold*',
  '**\u{1F600}x**',
  '\u{1F468}‍\u{1F469}‍\u{1F467} tail',
  '*héllo* there',
  '>',
  '>\n> after',
  '>\tfoo',
  '\tindented\ttabs',
  '- one\n  - nested\n\t- tabbed',
  '+ plus\n* star\n- dash',
  'line\n',
  '  padded  ',
  'a ==underlined== b',
  'Intro\n- one\n- two\n> quoted\nplain',
]);

describe('serializeJournalMarkdown', () => {
  it.each(CORPUS)('round trips %j byte for byte', (body) => {
    expect(serializeJournalMarkdown(parseJournalMarkdown(body))).toBe(body);
  });

  it('serializes only from the source stream, never from the derived views', () => {
    const body = '- one\n> **two**';
    const document = parseJournalMarkdown(body);

    document.blocks.length = 0;
    for (const format of document.formats) format.visible = false;

    expect(serializeJournalMarkdown(document)).toBe(body);
  });

  it.each(CORPUS)('keeps chars a faithful code-point stream of %j', (body) => {
    // Asserted independently of serializeJournalMarkdown so a serializer can
    // never mask a parser that dropped or rewrote a character.
    expect(parseJournalMarkdown(body).chars.join('')).toBe(body);
  });

  it.each(['éclair *bold*', '\t- tabbed\n  - spaced'])(
    'never normalises %j at parse time',
    (body) => {
      const document = parseJournalMarkdown(body);
      expect(document.chars.length).toBe(Array.from(body).length);
      expect(document.chars.join('')).toBe(body);
    },
  );
});

describe('source coordinates', () => {
  it('uses one conversion implementation, shared by reference with the anchor helper', () => {
    expect(utf16ToSource).toBe(utf16ToCodePoint);
  });

  it('is an exact right inverse: utf16ToSource(sourceToUtf16(cp)) === cp', () => {
    const body = '\u{1F600} **bold** tail';
    expect(body.length).toBe(16);
    expect(parseJournalMarkdown(body).chars.length).toBe(15);
    for (let cp = 0; cp <= 15; cp += 1) {
      expect(utf16ToSource(body, sourceToUtf16(body, cp))).toBe(cp);
    }
    expect(sourceToUtf16(body, 3)).toBe(4);
  });

  it.each(CORPUS)('is an exact right inverse over %j', (body) => {
    for (let cp = 0; cp <= Array.from(body).length; cp += 1) {
      expect(utf16ToSource(body, sourceToUtf16(body, cp))).toBe(cp);
    }
  });

  it('snaps a mid-surrogate UTF-16 index forward, idempotently', () => {
    // NOT a mutual inverse. utf16ToCodePoint is deliberately non-injective at a
    // mid-surrogate index -- codePoints.test.ts "returns a deterministic count
    // for an index landing mid-surrogate-pair" pins utf16ToCodePoint(t, 1) === 1,
    // the same value it gives for index 2. The reverse composition is therefore
    // an idempotent snap-forward to the end of the surrogate pair, not identity.
    const text = '\u{1F600}abc';
    expect(sourceToUtf16(text, utf16ToSource(text, 1))).toBe(2);
    expect(sourceToUtf16(text, utf16ToSource(text, 2))).toBe(2);
    for (const index of [0, 2, 3, 4, 5]) {
      expect(sourceToUtf16(text, utf16ToSource(text, index))).toBe(index);
    }
  });

  it('clamps out-of-range source indices without throwing', () => {
    const text = '\u{1F600}hi';
    expect(sourceToUtf16(text, -5)).toBe(0);
    expect(sourceToUtf16(text, 99)).toBe(text.length);
  });
});
