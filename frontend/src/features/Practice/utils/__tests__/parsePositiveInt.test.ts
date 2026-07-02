import { describe, expect, it } from '@jest/globals';

import { parsePositiveInt } from '../parsePositiveInt';

describe('parsePositiveInt', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('   ')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parsePositiveInt('0')).toBeNull();
  });

  it('returns null when no digits remain after stripping', () => {
    expect(parsePositiveInt('abc')).toBeNull();
  });

  it('parses a plain positive integer', () => {
    expect(parsePositiveInt('10')).toBe(10);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePositiveInt(' 10 ')).toBe(10);
  });

  it('strips non-digit characters, keeping the digits that remain', () => {
    // '10 min' strips the letters, leaving '10'.
    expect(parsePositiveInt('10 min')).toBe(10);
    // '-5' strips the minus sign, leaving '5' — the digit-strip is not sign-aware.
    expect(parsePositiveInt('-5')).toBe(5);
    // '3.5' strips the decimal point, leaving '35' — no fractional support.
    expect(parsePositiveInt('3.5')).toBe(35);
  });

  it('parses leading zeros as base-10', () => {
    expect(parsePositiveInt('007')).toBe(7);
  });
});
