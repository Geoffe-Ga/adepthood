/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  INLINE_DELIMITERS,
  parseJournalMarkdown,
  sourceToUtf16,
  utf16ToSource,
  type InlineStyle,
} from '../journalMarkdown';
import { inlineStyleActive, toggleInlineStyle } from '../markdownInlineToggle';

import { CORPUS } from './fixtures/journalMarkdownCorpus';

const STYLES: readonly InlineStyle[] = ['bold', 'italic', 'underline'];

/** The UTF-16 selection covering ``needle``'s first occurrence in ``body``. */
function around(body: string, needle: string): { start: number; end: number } {
  const start = body.indexOf(needle);
  return { start, end: start + needle.length };
}

/** Visible code points inside a UTF-16 selection of ``text``, with their formats. */
function selectedContent(text: string, selection: { start: number; end: number }) {
  const document = parseJournalMarkdown(text);
  const chars = Array.from(text);
  const low = Array.from(text.slice(0, selection.start)).length;
  const high = Array.from(text.slice(0, selection.end)).length;
  return (
    chars
      .slice(low, high)
      .map((char, offset) => ({ char, format: document.formats[low + offset]! }))
      // A line feed between two wrapped lines is never inside a pair; everything
      // else that is visible is the content the writer selected.
      .filter((entry) => entry.format.visible && entry.char !== '\n')
  );
}

describe('toggleInlineStyle -- wrapping a selection', () => {
  it.each(STYLES)('wraps a selected word in the %s delimiters the parser reads', (style) => {
    const { open, close } = INLINE_DELIMITERS[style];
    const body = 'a word here';
    const edit = toggleInlineStyle(body, around(body, 'word'), style);

    expect(edit).toEqual({
      text: `a ${open}word${close} here`,
      selection: { start: 2 + open.length, end: 2 + open.length + 4 },
    });
    const content = selectedContent(edit!.text, edit!.selection!);
    expect(content.map((entry) => entry.char).join('')).toBe('word');
    expect(content.every((entry) => entry.format[style])).toBe(true);
  });

  it('emits underline with the owner-ruled <u>…</u> tag, never ==', () => {
    const edit = toggleInlineStyle('say it', { start: 4, end: 6 }, 'underline');
    expect(edit?.text).toBe('say <u>it</u>');
  });

  it('trims whitespace off both edges before wrapping', () => {
    const body = 'a  word  b';
    expect(toggleInlineStyle(body, { start: 1, end: 8 }, 'bold')).toEqual({
      text: 'a  **word**  b',
      selection: { start: 5, end: 9 },
    });
  });

  it('returns null for a selection of nothing but whitespace', () => {
    expect(toggleInlineStyle('a   b', { start: 1, end: 4 }, 'bold')).toBeNull();
  });

  it('snaps a mid-word italic selection out to the word so it parses as italic', () => {
    const body = 'go forward now';
    const edit = toggleInlineStyle(body, around(body, 'ward'), 'italic');

    expect(edit).toEqual({ text: 'go _forward_ now', selection: { start: 4, end: 11 } });
    expect(parseJournalMarkdown(edit!.text).formats[4]).toMatchObject({ italic: true });
  });

  it('does not snap bold, which the dialect reads mid-word', () => {
    const body = 'forward';
    expect(toggleInlineStyle(body, around(body, 'ward'), 'bold')?.text).toBe('for**ward**');
  });

  it('wraps each selected line separately, leaving block prefixes outside', () => {
    const body = '- one\n- two';
    expect(toggleInlineStyle(body, { start: 0, end: body.length }, 'bold')).toEqual({
      text: '- **one**\n- **two**',
      selection: { start: 4, end: 17 },
    });
  });

  it('absorbs a same-style span the selection overlaps instead of nesting it', () => {
    const body = '**a b** c';
    expect(toggleInlineStyle(body, around(body, 'b** c'), 'bold')?.text).toBe('**a b c**');
  });

  it('wraps across another style without disturbing it', () => {
    const body = 'x *a* y';
    const edit = toggleInlineStyle(body, { start: 2, end: 5 }, 'underline');
    expect(edit?.text).toBe('x <u>*a*</u> y');
    expect(parseJournalMarkdown(edit!.text).formats[6]).toMatchObject({
      bold: true,
      underline: true,
    });
  });

  it('keeps UTF-16 selections exact after an astral prefix', () => {
    const body = '\u{1F600} bold';
    const edit = toggleInlineStyle(body, { start: 3, end: 7 }, 'bold');
    expect(edit).toEqual({ text: '\u{1F600} **bold**', selection: { start: 5, end: 9 } });
  });

  it('refuses a wrap the parser would not read, rather than corrupting the source', () => {
    // The closing delimiter would sit after a backslash and be escaped.
    expect(toggleInlineStyle('a\\ b', { start: 0, end: 2 }, 'bold')).toBeNull();
  });
});

describe('INLINE_DELIMITERS', () => {
  it.each(STYLES)('spells a %s pair the parser reads as that style', (style) => {
    const { open, close } = INLINE_DELIMITERS[style];
    const document = parseJournalMarkdown(`${open}a${close}`);
    expect(document.formats[Array.from(open).length]).toMatchObject({
      visible: true,
      [style]: true,
    });
    expect(document.inlineSpans).toEqual([
      {
        start: 0,
        contentStart: Array.from(open).length,
        contentEnd: Array.from(open).length + 1,
        end: Array.from(`${open}a${close}`).length,
        style,
      },
    ]);
  });
});

describe('toggleInlineStyle -- unwrapping', () => {
  it.each([
    ['*x*', 'x'],
    ['**x**', 'x'],
    ['__x__', 'x'],
  ])('removes exactly the delimiters of %j, whatever their width', (body, expected) => {
    expect(toggleInlineStyle(body, around(body, 'x'), 'bold')).toEqual({
      text: expected,
      selection: { start: 0, end: 1 },
    });
  });

  it.each(STYLES)('unwraps a %s span whose content is selected', (style) => {
    const { open, close } = INLINE_DELIMITERS[style];
    const body = `a ${open}word${close} b`;
    expect(toggleInlineStyle(body, around(body, 'word'), style)).toEqual({
      text: 'a word b',
      selection: { start: 2, end: 6 },
    });
  });

  it('unwraps a span when the selection includes its delimiters', () => {
    expect(toggleInlineStyle('**bold**', { start: 0, end: 8 }, 'bold')?.text).toBe('bold');
  });

  it('removes only the inner italic pair of *_x_*', () => {
    expect(toggleInlineStyle('*_x_*', { start: 2, end: 3 }, 'italic')).toEqual({
      text: '*x*',
      selection: { start: 1, end: 2 },
    });
  });

  it('removes only the outer bold pair of *_x_*', () => {
    expect(toggleInlineStyle('*_x_*', { start: 2, end: 3 }, 'bold')?.text).toBe('_x_');
  });

  it('wraps rather than unwraps when only part of the selection is styled', () => {
    const body = '**a** b';
    expect(toggleInlineStyle(body, { start: 0, end: body.length }, 'bold')?.text).toBe('**a b**');
  });
});

describe('toggleInlineStyle -- a collapsed caret', () => {
  it.each(STYLES)('inserts an empty %s pair with the caret between', (style) => {
    const { open, close } = INLINE_DELIMITERS[style];
    const edit = toggleInlineStyle('say ', { start: 4, end: 4 }, style);
    expect(edit).toEqual({
      text: `say ${open}${close}`,
      selection: { start: 4 + open.length, end: 4 + open.length },
    });
    // The next typed character takes the style.
    const typed = `say ${open}x${close}`;
    expect(parseJournalMarkdown(typed).formats[4 + Array.from(open).length]![style]).toBe(true);
  });

  it.each(STYLES)('removes an empty %s pair the caret sits between', (style) => {
    const { open, close } = INLINE_DELIMITERS[style];
    const caret = 4 + open.length;
    expect(toggleInlineStyle(`say ${open}${close}`, { start: caret, end: caret }, style)).toEqual({
      text: 'say ',
      selection: { start: 4, end: 4 },
    });
  });

  it('unwraps the span a caret sits inside', () => {
    expect(toggleInlineStyle('a **bold** b', { start: 6, end: 6 }, 'bold')).toEqual({
      text: 'a bold b',
      selection: { start: 4, end: 4 },
    });
  });

  it('unwraps the innermost same-style span holding the caret', () => {
    expect(toggleInlineStyle('_a *b* c_', { start: 4, end: 4 }, 'bold')?.text).toBe('_a b c_');
  });

  it('declines a mid-word italic caret, where no typed text could parse as italic', () => {
    expect(toggleInlineStyle('forward', { start: 3, end: 3 }, 'italic')).toBeNull();
  });
});

describe('inlineStyleActive', () => {
  it('reports the style at a caret inside a span, and not just past it', () => {
    expect(inlineStyleActive('**a**', { start: 3, end: 3 }, 'bold')).toBe(true);
    expect(inlineStyleActive('**a**', { start: 5, end: 5 }, 'bold')).toBe(false);
    expect(inlineStyleActive('**a**', { start: 3, end: 3 }, 'italic')).toBe(false);
  });

  it('reports a range only when every selected content point carries the style', () => {
    expect(inlineStyleActive('**a** b', { start: 2, end: 3 }, 'bold')).toBe(true);
    expect(inlineStyleActive('**a** b', { start: 0, end: 7 }, 'bold')).toBe(false);
    expect(inlineStyleActive('  ', { start: 0, end: 2 }, 'bold')).toBe(false);
  });
});

/** A toggle either refuses, or leaves the selected content wholly on or wholly off. */
function expectWholeToggle(
  body: string,
  selection: { start: number; end: number },
  style: InlineStyle,
): void {
  const edit = toggleInlineStyle(body, selection, style);
  // A range inside one surrogate pair is a collapsed caret in source terms.
  if (edit == null || utf16ToSource(body, selection.start) === utf16ToSource(body, selection.end)) {
    return;
  }
  const wanted = !inlineStyleActive(body, selection, style);
  const content = selectedContent(edit.text, edit.selection!);
  expect(content.length).toBeGreaterThan(0);
  expect(content.every((entry) => entry.format[style] === wanted)).toBe(true);
}

describe('toggleInlineStyle -- the parse postcondition, over the corpus', () => {
  /**
   * Every selection of every corpus body, for every style: the result is
   * either a refusal or source whose selected content ALL carries the style
   * (a wrap) or NONE of it does (an unwrap). No third outcome exists.
   */
  it.each(CORPUS)('never leaves %j half-styled', (body) => {
    for (const style of STYLES) {
      for (let start = 0; start <= body.length; start += 1) {
        for (let end = start; end <= body.length; end += 1)
          expectWholeToggle(body, { start, end }, style);
      }
    }
  });

  it('keeps every returned selection on code-point boundaries', () => {
    const body = '\u{1F600}a \u{1F600}b';
    for (let end = 1; end <= body.length; end += 1) {
      const edit = toggleInlineStyle(body, { start: 0, end }, 'bold');
      if (edit == null) continue;
      for (const bound of [edit.selection!.start, edit.selection!.end]) {
        const points = Array.from(edit.text.slice(0, bound)).length;
        expect(sourceToUtf16(edit.text, points)).toBe(bound);
      }
    }
  });
});
