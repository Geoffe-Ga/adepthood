import { describe, expect, it } from '@jest/globals';

import { alignPassage } from '../coursePassage';
import { stripLeadingTitleHeading } from '../stripLeadingTitleHeading';

/**
 * ``alignPassage`` (#3659) moves a Course quote's anchors from the chapter as
 * served to the chapter as shown, which has its title heading stripped.
 */
const SERVED = '# Chapter One\n\n\u{1F3B8} solo riff selected here.\n';
const SHOWN = stripLeadingTitleHeading(SERVED, 'Chapter One');

describe('alignPassage', () => {
  it('shifts by the code points the stripped heading took, not its UTF-16 units', () => {
    expect(alignPassage(SERVED, SHOWN, { start: 22, end: 26, text: 'riff' })).toEqual({
      start: 7,
      end: 11,
    });
  });

  it('leaves a span alone when nothing was stripped', () => {
    const plain = '\u{1F3B8} solo riff';
    expect(alignPassage(plain, plain, { start: 7, end: 11, text: 'riff' })).toEqual({
      start: 7,
      end: 11,
    });
  });

  it('checks a span with no words by range alone', () => {
    expect(alignPassage(SERVED, SHOWN, { start: 15, end: 16 })).toEqual({ start: 0, end: 1 });
  });

  it.each([
    ['its words moved', { start: 22, end: 26, text: 'rift' }],
    ['it begins in the heading', { start: 14, end: 26 }],
    ['it selects nothing', { start: 26, end: 26 }],
    ['it is inverted', { start: 26, end: 22 }],
    ['it runs past the end', { start: 22, end: 1000 }],
  ])('does not fit when %s', (_name, passage) => {
    expect(alignPassage(SERVED, SHOWN, passage)).toBeNull();
  });
});
