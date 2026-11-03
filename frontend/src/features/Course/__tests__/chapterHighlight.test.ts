// The Course deep link's span (#3659): offsets index body_markdown as served,
// the reader shows it with its title heading stripped, so the span is shifted
// back by the code points that strip removed -- and trusted only while it
// still matches the chapter.
import { describe, expect, it } from '@jest/globals';

import { resolveChapterHighlight, strippedPrefixLength } from '../chapterHighlight';

// "# Chapter One\n\n" is 15 code points; the astral emoji is ONE code point
// but two UTF-16 units, so "riff" sits at {22, 26} in the served body and at
// {7, 11} in the shown one -- the same pair ChapterReaderPassageSelection pins.
const RAW = '# Chapter One\n\n\u{1F3B8} solo riff selected here.\n';
const TITLE = 'Chapter One';

describe('strippedPrefixLength', () => {
  it('counts the code points of a stripped title heading and its blank line', () => {
    expect(strippedPrefixLength(RAW, TITLE)).toBe(15);
  });

  it('is zero when the heading is not the title', () => {
    expect(strippedPrefixLength(RAW, 'Another title')).toBe(0);
  });
});

describe('resolveChapterHighlight', () => {
  it('shifts a served span back by the stripped heading, in code points', () => {
    expect(resolveChapterHighlight(RAW, TITLE, { start: 22, end: 26, text: 'riff' })).toEqual({
      start: 7,
      end: 11,
    });
  });

  it('leaves a span alone when nothing was stripped', () => {
    const body = '\u{1F3B8} solo riff selected here.\n';
    expect(resolveChapterHighlight(body, TITLE, { start: 7, end: 11 })).toEqual({
      start: 7,
      end: 11,
    });
  });

  it('refuses a span whose words no longer sit there (the chapter was re-pinned)', () => {
    expect(
      resolveChapterHighlight(RAW, TITLE, { start: 22, end: 26, text: 'solo' }),
    ).toBeUndefined();
  });

  it.each([
    ['inside the stripped heading', { start: 2, end: 9 }],
    ['past the end of the body', { start: 40, end: 60 }],
    ['empty', { start: 22, end: 22 }],
    ['inverted', { start: 26, end: 22 }],
  ])('refuses a span %s', (_name, span) => {
    expect(resolveChapterHighlight(RAW, TITLE, span)).toBeUndefined();
  });

  it.each([
    ['no span', undefined],
    ['a string a web URL left behind', '[object Object]'],
    ['non-integer offsets', { start: 1.5, end: 4 }],
    ['words that are not a string', { start: 22, end: 26, text: 4 }],
  ])('opens normally for %s', (_name, value) => {
    expect(resolveChapterHighlight(RAW, TITLE, value)).toBeUndefined();
  });
});
