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
