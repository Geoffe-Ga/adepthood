import { describe, expect, it } from '@jest/globals';

import { nameToSlug, newStepUid } from '../types';

describe('nameToSlug', () => {
  it('snake-cases a simple name', () => {
    expect(nameToSlug('Find the Rainbow')).toBe('find_the_rainbow');
  });

  it('collapses runs of non-alpha to a single underscore', () => {
    expect(nameToSlug('5-4-3-2-1 grounding')).toBe('r_5_4_3_2_1_grounding');
  });

  it('prefixes leading digits so the result matches /^[a-z]/', () => {
    expect(nameToSlug('123 test')).toBe('r_123_test');
  });

  it('returns "untitled" for empty input', () => {
    expect(nameToSlug('')).toBe('untitled');
    expect(nameToSlug('!!!')).toBe('untitled');
  });

  it('trims leading and trailing underscores', () => {
    expect(nameToSlug('---hello---')).toBe('hello');
  });
});

describe('newStepUid', () => {
  it('returns a unique value each call', () => {
    const uids = new Set([newStepUid(), newStepUid(), newStepUid()]);
    expect(uids.size).toBe(3);
  });
});
