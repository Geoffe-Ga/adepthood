/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// RED: `excerpt.ts` doesn't exist yet -- pins excerpt(body, maxLength) as a code-point-safe truncator.
import { excerpt } from '../excerpt';

describe('excerpt', () => {
  it('flattens all whitespace to single spaces and trims both edges', () => {
    expect(excerpt('  a\n\tb   c  ', 100)).toBe('a b c');
  });

  it('returns a flattened, trimmed body with no ellipsis when under maxLength', () => {
    expect(excerpt('  short body  ', 100)).toBe('short body');
  });

  it('returns an ASCII body of exactly maxLength unchanged, with no ellipsis', () => {
    const body = 'abcde';
    expect(excerpt(body, 5)).toBe('abcde');
  });

  it('truncates a long ASCII body to maxLength code points then appends an ellipsis', () => {
    expect(excerpt('abcdefghij', 5)).toBe('abcde…');
  });

  it('trims a trailing space at the cut before appending the ellipsis', () => {
    expect(excerpt('abcd efghij', 5)).toBe('abcd…');
  });

  it('returns an empty string for an empty body, with no ellipsis', () => {
    expect(excerpt('', 5)).toBe('');
  });

  it('returns an empty string for an all-whitespace body, with no ellipsis', () => {
    expect(excerpt('   \n\t  ', 5)).toBe('');
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    const body = 'a'.repeat(4) + '\u{1F600}' + 'bbbb';
    const result = excerpt(body, 5);
    expect(result).toBe('aaaa\u{1F600}…');
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(result).not.toContain('�');
  });

  it('counts code points, not UTF-16 units, for emoji-dense truncation', () => {
    const body = '\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}';
    expect(excerpt(body, 3)).toBe('\u{1F600}\u{1F601}\u{1F602}…');
  });

  it('appends no ellipsis when the code-point count fits despite a longer UTF-16 length', () => {
    // Five code points (one astral) fit maxLength 5, though the UTF-16 length is 6.
    expect(excerpt('abcd\u{1F600}', 5)).toBe('abcd\u{1F600}');
  });
});
