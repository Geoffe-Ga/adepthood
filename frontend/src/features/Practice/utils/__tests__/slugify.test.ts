import { describe, expect, it } from '@jest/globals';

import { slugifyCore } from '../slugify';

describe('slugifyCore', () => {
  it('lowercases and underscores a simple name', () => {
    expect(slugifyCore('Find the Rainbow')).toBe('find_the_rainbow');
  });

  it('collapses runs of non-alphanumeric characters to a single underscore', () => {
    expect(slugifyCore('5-4-3-2-1 grounding')).toBe('5_4_3_2_1_grounding');
  });

  it('trims leading and trailing underscores', () => {
    expect(slugifyCore('---hello---')).toBe('hello');
  });

  it('returns an empty string for all-punctuation input', () => {
    expect(slugifyCore('!!!')).toBe('');
  });

  it('keeps existing digits and letters unchanged', () => {
    expect(slugifyCore('The Sun')).toBe('the_sun');
  });
});
