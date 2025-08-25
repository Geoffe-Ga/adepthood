import { describe, it, expect } from '@jest/globals';

import { calculateNetEnergy } from '../EnergyUtils';
import { getStaggeredStartDate } from '../OnboardingUtils';

describe('energy utilities', () => {
  it('calculates net energy as return minus cost', () => {
    expect(calculateNetEnergy(3, 10)).toBe(7);
  });

  it('staggered start dates follow 21/42 day pattern', () => {
    const base = new Date('2025-01-01');
    const ninth = getStaggeredStartDate(base, 8);
    const tenth = getStaggeredStartDate(base, 9);
    const diff9 = (ninth.getTime() - base.getTime()) / (1000 * 60 * 60 * 24);
    const diff10 = (tenth.getTime() - ninth.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff9).toBe(189);
    expect(diff10).toBe(42);
  });
});
