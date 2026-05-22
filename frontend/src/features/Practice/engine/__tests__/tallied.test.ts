import { describe, expect, it } from '@jest/globals';

import { decompose, totalSteps, totalStepsPerRound } from '../tallied';
import type { TalliedGroundingConfig } from '../types';

const config: TalliedGroundingConfig = {
  mode: 'tallied_grounding',
  rounds: 3,
  categories: [
    { key: 'squares', label: 'a square', target_count: 3 },
    { key: 'triangles', label: 'a triangle', target_count: 3 },
    { key: 'circles', label: 'a circle', target_count: 3 },
  ],
};

describe('tallied helpers', () => {
  it('sums target counts for a single round', () => {
    expect(totalStepsPerRound(config)).toBe(9);
  });

  it('multiplies the per-round total by the round count', () => {
    expect(totalSteps(config)).toBe(27);
  });

  it('decomposes the first step into round 1, first category, first item', () => {
    expect(decompose(0, config)).toMatchObject({
      roundIndex: 0,
      categoryIndex: 0,
      itemInCategory: 0,
    });
    expect(decompose(0, config).category.key).toBe('squares');
  });

  it('decomposes a mid-round step into the right category and item', () => {
    expect(decompose(4, config)).toMatchObject({
      roundIndex: 0,
      categoryIndex: 1,
      itemInCategory: 1,
    });
  });

  it('rolls into the next round at the round boundary', () => {
    expect(decompose(9, config)).toMatchObject({
      roundIndex: 1,
      categoryIndex: 0,
      itemInCategory: 0,
    });
  });

  it('clamps an overrun step index to the final item', () => {
    expect(decompose(27, config)).toMatchObject({
      roundIndex: 2,
      categoryIndex: 2,
      itemInCategory: 2,
    });
  });

  it('clamps a negative step index to the first item', () => {
    expect(decompose(-5, config)).toMatchObject({
      roundIndex: 0,
      categoryIndex: 0,
      itemInCategory: 0,
    });
  });

  it('throws when the config has no categories', () => {
    const empty: TalliedGroundingConfig = { mode: 'tallied_grounding', rounds: 1, categories: [] };
    expect(() => decompose(0, empty)).toThrow(/no categories/);
  });
});
