/* global describe, it, expect */
import { chart, surface } from '../tokens';

const lightness = (hex: string): number => {
  const values = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const high = Math.max(...values);
  const low = Math.min(...values);
  return (high + low) / 2;
};

describe('one-hue chart ramp', () => {
  it('deepens monotonically with at least 0.06 lightness between neighbors', () => {
    const levels = chart.tier.map(lightness);
    expect(levels[0]! - levels[1]!).toBeGreaterThanOrEqual(0.06);
    expect(levels[1]! - levels[2]!).toBeGreaterThanOrEqual(0.06);
    expect(chart.heat).toHaveLength(5);
    expect(chart.heat[0]).toBe(surface.sunken);
    expect(chart.heat[4]).toBe(chart.tier[2]);
  });
});
