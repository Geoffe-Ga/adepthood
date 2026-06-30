/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { rhythm, spacing } from '../tokens';

describe('rhythm tokens (#825)', () => {
  it('exposes the screen-rhythm keys as positive numbers', () => {
    for (const value of Object.values(rhythm)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
    expect(Object.keys(rhythm)).toEqual([
      'screenPaddingH',
      'screenPaddingTop',
      'sectionGap',
      'blockGap',
      'heroPaddingV',
    ]);
  });

  it('derives from the spacing scale (not magic numbers)', () => {
    expect(rhythm.screenPaddingH).toBe(spacing(2));
    expect(rhythm.sectionGap).toBe(spacing(3));
    expect(rhythm.blockGap).toBe(spacing(1.5));
  });

  it('orders section gaps wider than block gaps', () => {
    expect(rhythm.sectionGap).toBeGreaterThan(rhythm.blockGap);
  });
});
