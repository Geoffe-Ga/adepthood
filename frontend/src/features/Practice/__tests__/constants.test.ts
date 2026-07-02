/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { MAX_STAGE, MIN_STAGE, stageRange } from '../constants';

describe('stageRange', () => {
  it('returns the inclusive integer range MIN_STAGE..MAX_STAGE', () => {
    expect(stageRange()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('starts at MIN_STAGE and ends at MAX_STAGE', () => {
    const range = stageRange();
    expect(range[0]).toBe(MIN_STAGE);
    expect(range[range.length - 1]).toBe(MAX_STAGE);
  });

  it('has exactly MAX_STAGE - MIN_STAGE + 1 entries', () => {
    expect(stageRange()).toHaveLength(MAX_STAGE - MIN_STAGE + 1);
  });

  it('is every integer, strictly ascending by 1', () => {
    const range = stageRange();
    range.forEach((value, index) => {
      expect(Number.isInteger(value)).toBe(true);
      const previous = range[index - 1];
      if (previous !== undefined) {
        expect(value - previous).toBe(1);
      }
    });
  });
});
