/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  parseJournalMarkdown,
  revealedDelimiters,
  serializeJournalMarkdown,
  sourceRuns,
  sourceToVisible,
  spanAt,
  utf16ToSource,
  visibleToSource,
} from '../journalMarkdown';
import { continueMarkdownEdit, deleteBackwardEdit } from '../markdownEditing';

describe('visibleToSource tie-breaks', () => {
  it('binds a caret before a LEADING hidden run to the document start, outside the span', () => {
    // '**bold**' hides source 0 and 1. Rendered position 0 is reachable from
    // source 0, 1 and 2; only source 0 is where a caret on an untouched page
    // actually is, so naming it 2 would jump the caret into the emphasis.
    const document = parseJournalMarkdown('**bold**');
    expect(visibleToSource(document, 0)).toBe(0);
  });

  it('binds every other rendered position to its own character', () => {
    const document = parseJournalMarkdown('a**b**c');
    expect(visibleToSource(document, 0)).toBe(0);
    expect(visibleToSource(document, 1)).toBe(3);
    expect(visibleToSource(document, 2)).toBe(6);
  });

  it('names the end of the document past a trailing hidden run', () => {
    const document = parseJournalMarkdown('**bold**');
    expect(visibleToSource(document, 4)).toBe(8);
  });

  it('counts rendered characters before a source position', () => {
    const document = parseJournalMarkdown('**bold**');
    expect([0, 2, 3, 6, 8].map((index) => sourceToVisible(document, index))).toEqual([
      0, 0, 1, 4, 4,
    ]);
  });

  it('clamps out-of-range arguments instead of throwing', () => {
    const document = parseJournalMarkdown('a**b**c');
    expect(sourceToVisible(document, -4)).toBe(0);
    expect(sourceToVisible(document, 99)).toBe(3);
    expect(visibleToSource(document, -4)).toBe(0);
    expect(visibleToSource(document, 99)).toBe(7);
  });

  it('agrees with utf16ToSource on a caret the textarea reports', () => {
    // The caret is driven from UTF-16, never from visibleToSource: exact on any
    // position a caret can occupy, including one after an astral character.
    const body = '\u{1F600}**bold**';
    expect(utf16ToSource(body, 2)).toBe(1);
  });
});

describe('spanAt', () => {
  it('covers the styled text and both delimiter runs', () => {
    const document = parseJournalMarkdown('**bold**');
    expect(spanAt(document, 3)).toEqual({
      start: 0,
      end: 8,
      bold: true,
      italic: false,
      underline: false,
    });
    expect(spanAt(document, 0)).toMatchObject({ start: 0, end: 8 });
  });

  it('bounds an interior span to its own delimiters', () => {
    const document = parseJournalMarkdown('a**b**c');
    expect(spanAt(document, 3)).toMatchObject({ start: 1, end: 6 });
  });

  it.each([
    ['a**b**c', 0],
    ['a**b**c', 6],
    ['- one', 0],
    ['> quoted', 0],
    ['plain', 2],
  ])('returns null for %j at %i -- prose or a block prefix is not a span', (body, index) => {
    expect(spanAt(parseJournalMarkdown(body), index)).toBeNull();
  });

  it('keeps a closing delimiter inside its own span when two spans abut', () => {
    // '**bold**_italic_' has no visible character between the bold span's
    // closing '**' and the italic span's opening '_'. Source 6 is the first '*'
    // of the BOLD close -- the caret position a writer lands on most often,
    // immediately after an emphasised word -- so it must report the bold span,
    // not the italic one that merely abuts it.
    const document = parseJournalMarkdown('**bold**_italic_');
    const bold = { start: 0, end: 8, bold: true, italic: false, underline: false };
    const italic = { start: 8, end: 16, bold: false, italic: true, underline: false };
    expect(spanAt(document, 6)).toEqual(bold);
    expect(spanAt(document, 7)).toEqual(bold);
    expect(spanAt(document, 3)).toEqual(bold);
    expect(spanAt(document, 8)).toEqual(italic);
    expect(spanAt(document, 15)).toEqual(italic);
  });

  it.each([
    ['- **a**', 2],
    ['> **a**', 2],
    ['  - **a**', 4],
  ])(
    'never lets the hidden block prefix of %j join the inline span at %i',
    (body, contentStart) => {
      const document = parseJournalMarkdown(body);
      for (let index = 0; index < contentStart; index += 1) {
        expect(spanAt(document, index)).toBeNull();
      }
      expect(spanAt(document, contentStart)).toEqual({
        start: contentStart,
        end: contentStart + 5,
        bold: true,
        italic: false,
        underline: false,
      });
    },
  );

  it('reports the outermost owner and every style in force when spans nest', () => {
    // The '*' pass runs before the '_' pass, so in '_*a*_' the INNER pair is
    // recorded first. A reveal has to un-hide both pairs, which is the OUTER
    // range -- picking the first recorded owner would under-report it.
    const nested = { start: 0, end: 5, bold: true, italic: true, underline: false };
    expect(spanAt(parseJournalMarkdown('_*a*_'), 2)).toEqual(nested);
    expect(spanAt(parseJournalMarkdown('*_a_*'), 2)).toEqual(nested);

    // An outer pair's own delimiter is not inside the inner pair, so only the
    // outer style is in force there.
    expect(spanAt(parseJournalMarkdown('_*a*_'), 0)).toEqual({
      start: 0,
      end: 5,
      bold: false,
      italic: true,
      underline: false,
    });
    expect(spanAt(parseJournalMarkdown('*_a_*'), 0)).toEqual({
      start: 0,
      end: 5,
      bold: true,
      italic: false,
      underline: false,
    });
  });

  it('reports an underlined span', () => {
    expect(spanAt(parseJournalMarkdown('a ==und== b'), 5)).toMatchObject({
      start: 2,
      end: 9,
      underline: true,
    });
  });
});

describe('revealedDelimiters', () => {
  it('reveals both delimiter runs for a caret inside the span', () => {
    const document = parseJournalMarkdown('**bold**');
    expect(revealedDelimiters(document, { start: 3, end: 3 })).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
  });

  it.each([0, 8])('stays quiet for a caret at %i, which only abuts the span', (caret) => {
    const document = parseJournalMarkdown('**bold**');
    expect(revealedDelimiters(document, { start: caret, end: caret })).toEqual([]);
  });

  it('reveals every span a selected range touches', () => {
    const document = parseJournalMarkdown('*a* b _c_');
    expect(revealedDelimiters(document, { start: 0, end: 9 })).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 6, end: 7 },
      { start: 8, end: 9 },
    ]);
  });

  it('reveals only the caret\u2019s own span when two spans abut', () => {
    const document = parseJournalMarkdown('**bold**_italic_');
    expect(revealedDelimiters(document, { start: 6, end: 6 })).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
    expect(revealedDelimiters(document, { start: 12, end: 12 })).toEqual([
      { start: 8, end: 9 },
      { start: 15, end: 16 },
    ]);
  });

  it.each([
    ['- **a**', 2],
    ['> **a**', 2],
    ['  - **a**', 4],
  ])('reveals emphasis but never the hidden block marker of %j', (body, contentStart) => {
    const document = parseJournalMarkdown(body);
    expect(
      revealedDelimiters(document, { start: contentStart + 2, end: contentStart + 2 }),
    ).toEqual([
      { start: contentStart, end: contentStart + 2 },
      { start: contentStart + 3, end: contentStart + 5 },
    ]);
  });

  it('reveals both delimiter pairs of a nested span', () => {
    expect(revealedDelimiters(parseJournalMarkdown('_*a*_'), { start: 2, end: 2 })).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('returns the ranges in ascending order even when two spans overlap', () => {
    // '*_=*_' is the one shape where the flattened ranges are NOT already
    // ascending: the bold pair [0,4) and the italic pair [1,5) overlap without
    // nesting, so the second span's first hidden run starts before the first
    // span's last one. The documented ascending order is a sort, not an
    // accident of discovery order.
    const document = parseJournalMarkdown('*_=*_');
    expect(revealedDelimiters(document, { start: 0, end: 5 })).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 3, end: 5 },
    ]);
  });

  it('never writes a visible flag on the stored document', () => {
    const body = '**bold** and _soft_';
    const document = parseJournalMarkdown(body);
    const before = document.formats.map((format) => format.visible);

    for (let caret = 0; caret <= document.chars.length; caret += 1) {
      revealedDelimiters(document, { start: caret, end: caret });
      spanAt(document, caret);
      visibleToSource(document, sourceToVisible(document, caret));
    }

    expect(document.formats.map((format) => format.visible)).toEqual(before);
    expect(serializeJournalMarkdown(document)).toBe(body);
  });
});

describe('sourceRuns', () => {
  it('covers every position, flagging the hidden delimiters instead of dropping them', () => {
    const document = parseJournalMarkdown('a*b*');
    const runs = sourceRuns(document, 0, document.chars.length);
    expect(runs.map((run) => [run.start, run.end, run.text, run.visible, run.bold])).toEqual([
      [0, 1, 'a', true, false],
      [1, 2, '*', false, false],
      [2, 3, 'b', true, true],
      [3, 4, '*', false, false],
    ]);
    expect(runs.map((run) => run.text).join('')).toBe('a*b*');
  });

  /**
   * Every term of the run comparator, pinned one at a time.
   *
   * ``markdownRuns`` cannot reach the comparator: a style change in this
   * dialect is always bounded by hidden delimiters, so two adjacent VISIBLE
   * characters never differ in style and the visibility flag alone splits the
   * run. ``sourceRuns`` keeps the delimiters, and nested emphasis gives a
   * delimiter the OUTER pass's style while its neighbour has none -- which is
   * the only place each term is observable.
   */
  it.each([
    ['bold', '*_a_*', ['*', '_', 'a', '_', '*']],
    ['italic', '_*a*_', ['_', '*', 'a', '*', '_']],
    ['underline', '==*a*==', ['==', '*', 'a', '*', '==']],
  ])('splits adjacent hidden delimiters that differ only in %s', (_term, body, texts) => {
    const document = parseJournalMarkdown(body);
    expect(sourceRuns(document, 0, document.chars.length).map((run) => run.text)).toEqual(texts);
  });

  it('carries the outer style onto the inner delimiter it wraps', () => {
    // '*_a_*': the '_' at source 1 is hidden AND bold, its neighbour '*' at 0
    // is hidden and not bold. Without the bold term the two would be one run.
    const document = parseJournalMarkdown('*_a_*');
    expect(
      sourceRuns(document, 0, 5).map((run) => [run.text, run.bold, run.italic, run.underline]),
    ).toEqual([
      ['*', false, false, false],
      ['_', true, false, false],
      ['a', true, true, false],
      ['_', true, false, false],
      ['*', false, false, false],
    ]);
  });

  it('keeps a hidden bullet prefix present and flagged', () => {
    const document = parseJournalMarkdown('- one');
    expect(sourceRuns(document, 0, 5)[0]).toMatchObject({ start: 0, end: 2, visible: false });
  });
});

describe('editing rules over the model', () => {
  it('leaves the body byte-identical across a sequence of caret-only moves', () => {
    const body = 'Intro\n- one\n> **two** and _three_\n';
    const document = parseJournalMarkdown(body);

    for (let caret = 0; caret <= document.chars.length; caret += 1) {
      visibleToSource(document, sourceToVisible(document, caret));
      revealedDelimiters(document, { start: caret, end: caret });
    }

    expect(serializeJournalMarkdown(document)).toBe(body);
  });

  it('does not rewrite a Return pressed in the middle of a span', () => {
    const previous = 'a **bold** b';
    const next = 'a **bo\nld** b';
    expect(continueMarkdownEdit(previous, next, { start: 6, end: 6 })).toEqual({ text: next });
  });

  it('joins a marked line into prose by removing its whole prefix', () => {
    expect(deleteBackwardEdit('Intro\n- one', { start: 8, end: 8 })).toEqual({
      text: 'Intro\none',
      selection: { start: 6, end: 6 },
    });
  });

  it('leaves the source intact when a whole span is deleted by the field', () => {
    const after = 'a  b';
    expect(continueMarkdownEdit('a **x** b', after)).toEqual({ text: after });
    expect(serializeJournalMarkdown(parseJournalMarkdown(after))).toBe(after);
  });
});
