/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  INLINE_DELIMITERS,
  UNDERLINE_DELIMITER,
  markdownRuns,
  parseJournalMarkdown,
} from '../journalMarkdown';

describe('bullet blocks', () => {
  it('groups adjacent bullet lines into one block without swallowing its neighbours', () => {
    const document = parseJournalMarkdown('Intro\n- one\n- two\n> quoted\nplain');

    expect(document.blocks.map((block) => block.kind)).toEqual([
      'plain',
      'bullet',
      'quote',
      'plain',
    ]);
    expect(document.blocks[1]!.lines).toHaveLength(2);
    expect(document.blocks[1]!.start).toBe(6);
    expect(document.blocks[1]!.quote).toBe(false);
    expect(document.blocks[2]!.quote).toBe(true);
  });

  it('hides the indent and marker without removing them from the source stream', () => {
    const body = '  - nested';
    const document = parseJournalMarkdown(body);

    expect(document.formats.slice(0, 4).map((format) => format.visible)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(document.formats[4]!.visible).toBe(true);
    expect(document.chars.join('')).toBe(body);
  });

  it('exposes the distinct non-zero bullet indent widths for indent-unit inference', () => {
    const document = parseJournalMarkdown('- a\n  - b\n\t- c\n    - d');
    expect(document.indentWidths).toEqual([2, 4]);
  });

  it('reports no indent widths for a document with only flush bullets', () => {
    expect(parseJournalMarkdown('- a\n- b').indentWidths).toEqual([]);
  });
});

describe('underline', () => {
  it('renders <u>x</u> as an underlined run, leaving the other delimiters alone', () => {
    const body = 'a <u>und</u> b';
    const document = parseJournalMarkdown(body);

    expect(document.formats.slice(2, 5).map((format) => format.visible)).toEqual([
      false,
      false,
      false,
    ]);
    expect(document.formats.slice(8, 12).map((format) => format.visible)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(markdownRuns(document, 0, document.chars.length)).toEqual([
      { start: 0, end: 2, text: 'a ', visible: true, bold: false, italic: false, underline: false },
      { start: 5, end: 8, text: 'und', visible: true, bold: false, italic: false, underline: true },
      {
        start: 12,
        end: 14,
        text: ' b',
        visible: true,
        bold: false,
        italic: false,
        underline: false,
      },
    ]);
  });

  it('spells the underline pair with the one exported constant', () => {
    expect(UNDERLINE_DELIMITER).toEqual({ open: '<u>', close: '</u>' });
    expect(INLINE_DELIMITERS.underline).toBe(UNDERLINE_DELIMITER);
    const { open, close } = UNDERLINE_DELIMITER;
    const document = parseJournalMarkdown(`${open}x${close}`);
    expect(document.formats[open.length]).toMatchObject({ visible: true, underline: true });
  });

  it.each(['a ==und== b', '==und==', '*==und==*'])(
    'reads the retired %j spelling as plain prose, never underline',
    (body) => {
      const document = parseJournalMarkdown(body);
      expect(document.formats.some((format) => format.underline)).toBe(false);
      const equalsSigns = Array.from(body).flatMap((char, index) => (char === '=' ? [index] : []));
      expect(equalsSigns.every((index) => document.formats[index]!.visible)).toBe(true);
    },
  );

  it.each([
    ['an escaped opener', 'a \\<u>x</u> b'],
    ['an escaped closer', 'a <u>x\\</u> b'],
    ['an opener followed by whitespace', 'a <u> x</u> b'],
    ['a closer preceded by whitespace', 'a <u>x </u> b'],
    ['an empty pair', 'a <u></u> b'],
    ['an unclosed opener', 'a <u>x b'],
    ['an upper-case tag', 'a <U>x</U> b'],
    ['a pair split across lines', 'a <u>x\ny</u> b'],
    ['any other HTML-looking tag', 'a <b>x</b> b'],
  ])('leaves %s plain: %j', (_rule, body) => {
    const document = parseJournalMarkdown(body);
    expect(document.formats.some((format) => format.underline)).toBe(false);
    expect(document.formats.every((format) => format.visible)).toBe(true);
  });

  it('pairs each opener with the nearest usable closer on its line', () => {
    const document = parseJournalMarkdown('<u>a</u> b <u>c</u>');
    expect(document.inlineSpans.filter((span) => span.style === 'underline')).toHaveLength(2);
    expect(document.formats[9]).toMatchObject({ visible: true, underline: false });
  });

  it.each([
    ['a *bold* b', 'bold'],
    ['a __also bold__ b', 'also bold'],
  ])('keeps %j meaning bold, not underline or italic', (body, text) => {
    const document = parseJournalMarkdown(body);
    const index = Array.from(body).indexOf(text[0]!, 2);
    expect(document.formats[index]).toMatchObject({ bold: true, italic: false, underline: false });
  });

  it('keeps _x_ meaning italic', () => {
    const document = parseJournalMarkdown('a _soft_ b');
    expect(document.formats[3]).toMatchObject({ bold: false, italic: true, underline: false });
  });

  it('composes underline with bold and italic independently', () => {
    const document = parseJournalMarkdown('*_<u>all</u>_*');
    expect(document.formats[5]).toMatchObject({ bold: true, italic: true, underline: true });
    expect(parseJournalMarkdown('<u>*_all_*</u>').formats[5]).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
    });
  });
});
