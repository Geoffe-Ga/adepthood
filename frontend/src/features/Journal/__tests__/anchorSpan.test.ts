/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { ANCHOR_EDGE_WHITESPACE, selectionToAnchorSpan } from '../anchorSpan';
import { sourceToUtf16 } from '../journalMarkdown';

/** The code-point slice the server will take for ``span``. */
function slice(body: string, span: { start: number; end: number }): string {
  return Array.from(body).slice(span.start, span.end).join('');
}

/** The UTF-16 selection a TextInput reports for the first ``text`` in ``body``. */
function selectionOf(body: string, text: string): { start: number; end: number } {
  const start = body.indexOf(text);
  if (start < 0) throw new Error('fixture text not in body');
  return { start, end: start + text.length };
}

const EMOJI = '\u{1F600}';

describe('selectionToAnchorSpan (#2891)', () => {
  const ROWS: { name: string; body: string; selected: string; expected: string }[] = [
    {
      name: 'an astral emoji',
      body: `${EMOJI} by the river`,
      selected: 'the river',
      expected: 'the river',
    },
    {
      name: 'a precomposed mark',
      body: 'Café by the river',
      selected: 'Café by',
      expected: 'Café by',
    },
    {
      name: 'an escaped marker',
      body: 'a \\*literal\\* star',
      selected: '\\*literal\\*',
      expected: '\\*literal\\*',
    },
    {
      name: 'a nested bullet',
      body: '- top\n  - nested line',
      selected: '  - nested',
      expected: '- nested',
    },
    { name: 'bold', body: 'so **bold** here', selected: '**bold**', expected: '**bold**' },
    { name: 'italic', body: 'so _soft_ here', selected: '_soft_', expected: '_soft_' },
    {
      name: 'underline',
      body: 'so <u>under</u> here',
      selected: '<u>under</u>',
      expected: '<u>under</u>',
    },
    { name: 'a trailing space', body: 'a word here', selected: 'word ', expected: 'word' },
    { name: 'a leading space', body: 'a word here', selected: ' word', expected: 'word' },
    { name: 'edge newlines', body: 'one\ntwo\nthree', selected: '\ntwo\n', expected: 'two' },
    { name: 'a NEL at the edge', body: 'one\u0085two', selected: '\u0085two', expected: 'two' },
    { name: 'a no-break space at the edge', body: 'one two', selected: 'one ', expected: 'one' },
    {
      name: 'an ideographic space at the edge',
      body: 'one　two',
      selected: '　two',
      expected: 'two',
    },
    { name: 'inner whitespace', body: 'a  b', selected: 'a  b', expected: 'a  b' },
  ];

  it.each(ROWS)(
    'keeps the server slice equal to its trim for $name',
    ({ body, selected, expected }) => {
      const span = selectionToAnchorSpan(body, selectionOf(body, selected));
      expect(slice(body, span)).toBe(expected);
      expect(slice(body, span)).toBe(slice(body, span).trim());
    },
  );

  it('reports code-point offsets, not UTF-16 ones, after an astral character', () => {
    const body = `${EMOJI}${EMOJI} tail`;
    const span = selectionToAnchorSpan(body, selectionOf(body, 'tail'));
    expect(span).toEqual({ start: 3, end: 7 });
    expect(sourceToUtf16(body, span.start)).toBe(5);
  });

  it('collapses a whitespace-only selection to an empty span', () => {
    const body = 'one   two';
    const span = selectionToAnchorSpan(body, { start: 3, end: 6 });
    expect(span.end).toBe(span.start);
  });

  it('keeps a collapsed caret collapsed', () => {
    expect(selectionToAnchorSpan('abc', { start: 1, end: 1 })).toEqual({ start: 1, end: 1 });
  });

  it("mirrors Python's str.isspace, not JavaScript's \\s", () => {
    // Python strips these; JavaScript's \s misses them.
    for (const ch of ['\u0085', '\u001C', '\u001D', '\u001E', '\u001F']) {
      expect(ANCHOR_EDGE_WHITESPACE.has(ch)).toBe(true);
    }
    // JavaScript's \s includes U+FEFF; Python does not treat it as whitespace.
    expect(ANCHOR_EDGE_WHITESPACE.has('﻿')).toBe(false);
    expect(ANCHOR_EDGE_WHITESPACE.has('​')).toBe(false);
    expect(ANCHOR_EDGE_WHITESPACE.size).toBe(29);
  });
});
