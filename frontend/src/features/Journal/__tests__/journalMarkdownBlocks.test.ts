/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { markdownRuns, parseJournalMarkdown } from '../journalMarkdown';

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
  it('renders ==x== as an underlined run, leaving the other delimiters alone', () => {
    const body = 'a ==und== b';
    const document = parseJournalMarkdown(body);

    expect(document.formats[2]!.visible).toBe(false);
    expect(document.formats[3]!.visible).toBe(false);
    expect(markdownRuns(document, 0, document.chars.length)).toEqual([
      { start: 0, end: 2, text: 'a ', visible: true, bold: false, italic: false, underline: false },
      { start: 4, end: 7, text: 'und', visible: true, bold: false, italic: false, underline: true },
      {
        start: 9,
        end: 11,
        text: ' b',
        visible: true,
        bold: false,
        italic: false,
        underline: false,
      },
    ]);
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
    const document = parseJournalMarkdown('*_==all==_*');
    expect(document.formats[5]).toMatchObject({ bold: true, italic: true, underline: true });
  });
});
