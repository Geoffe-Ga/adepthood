/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// RED: `codePoints.ts` doesn't exist yet -- pins utf16ToCodePoint(text, i) as count(text.slice(0, i)).
import { codePointToUtf16, utf16ToCodePoint } from '../codePoints';

describe('utf16ToCodePoint', () => {
  it('is the identity for a pure-ASCII string', () => {
    const text = 'hello world';
    expect(utf16ToCodePoint(text, 5)).toBe(5);
  });

  it('returns 0 for a UTF-16 index of 0, even over an astral-led body', () => {
    expect(utf16ToCodePoint('\u{1F600}hello', 0)).toBe(0);
  });

  it('subtracts one for an index positioned right after one leading astral char', () => {
    const text = '\u{1F600}hello';
    // The emoji is a 2-unit surrogate pair; index 2 sits right after it, before "h".
    expect(utf16ToCodePoint(text, 2)).toBe(1);
  });

  it('shifts by the count of leading astral characters', () => {
    const text = '\u{1F600}\u{1F601}\u{1F602}hello';
    // Three leading emoji (2 UTF-16 units each = 6 units), then "he" (2 more).
    expect(utf16ToCodePoint(text, 8)).toBe(5);
  });

  it('clamps to the code-point length when the index sits exactly at the end', () => {
    const text = '\u{1F600}hi';
    expect(utf16ToCodePoint(text, text.length)).toBe(3);
  });

  it('clamps to the code-point length when the index is past the end, without throwing', () => {
    const text = '\u{1F600}hi';
    expect(() => utf16ToCodePoint(text, text.length + 50)).not.toThrow();
    expect(utf16ToCodePoint(text, text.length + 50)).toBe(3);
  });

  it('returns a deterministic count for an index landing mid-surrogate-pair', () => {
    const text = '\u{1F600}abc';
    // text.slice(0, 1) is the lone high surrogate, which iterates as one element.
    expect(utf16ToCodePoint(text, 1)).toBe(1);
  });
});

describe('codePointToUtf16', () => {
  it('is the identity for a pure-ASCII string', () => {
    expect(codePointToUtf16('hello world', 5)).toBe(5);
  });

  it('returns 0 for a code-point index of 0, even over an astral-led body', () => {
    expect(codePointToUtf16('\u{1F600}hello', 0)).toBe(0);
  });

  it('adds one for an index positioned right after one leading astral char', () => {
    expect(codePointToUtf16('\u{1F600}hello', 1)).toBe(2);
  });

  it('shifts by the count of leading astral characters', () => {
    expect(codePointToUtf16('\u{1F600}\u{1F601}\u{1F602}hello', 5)).toBe(8);
  });

  it('clamps to the UTF-16 length when the index sits exactly at the end', () => {
    const text = '\u{1F600}hi';
    expect(codePointToUtf16(text, 3)).toBe(text.length);
  });

  it('clamps to the UTF-16 length when the index is past the end, without throwing', () => {
    const text = '\u{1F600}hi';
    expect(() => codePointToUtf16(text, 50)).not.toThrow();
    expect(codePointToUtf16(text, 50)).toBe(text.length);
  });

  it('clamps a negative index to 0 rather than counting from the end', () => {
    expect(codePointToUtf16('\u{1F600}abc', -3)).toBe(0);
  });
});

describe('the two directions together', () => {
  it.each(['', 'hello', '\u{1F600}abc', 'e\u0301clair', 'a\u{1F600}b\u{1F601}c'])(
    'is an exact right inverse over %j',
    (text) => {
      for (let cp = 0; cp <= Array.from(text).length; cp += 1) {
        expect(utf16ToCodePoint(text, codePointToUtf16(text, cp))).toBe(cp);
      }
    },
  );

  it('is a snap-forward, not an inverse, at a mid-surrogate UTF-16 index', () => {
    // utf16ToCodePoint is deliberately non-injective here: index 1 and index 2
    // of '\u{1F600}abc' both count 1 code point, as the mid-surrogate case
    // above pins. The composition therefore clamps index 1 forward to 2, and is
    // idempotent from there. A test phrased as a mutual bijection would be red
    // on correct code.
    const text = '\u{1F600}abc';
    expect(codePointToUtf16(text, utf16ToCodePoint(text, 1))).toBe(2);
    expect(codePointToUtf16(text, utf16ToCodePoint(text, 2))).toBe(2);
  });
});
