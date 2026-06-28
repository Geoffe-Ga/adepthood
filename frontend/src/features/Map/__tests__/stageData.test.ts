/* eslint-env jest */
/* global describe, it, expect */
import { HOTSPOTS, STAGE_COUNT } from '../stageData';

const SIDE_SPLIT = 40;

describe('stageData', () => {
  it('provides one arrow hotspot for every stage', () => {
    expect(HOTSPOTS).toHaveLength(STAGE_COUNT);
    HOTSPOTS.forEach((spots) => expect(spots).toHaveLength(1));
  });

  it('has non-overlapping vertical hotspot ranges', () => {
    for (let i = 0; i < HOTSPOTS.length - 1; i++) {
      const current = HOTSPOTS[i]!;
      const next = HOTSPOTS[i + 1]!;
      const currentBottom = Math.max(...current.map((h) => h.top + h.height));
      const nextTop = Math.min(...next.map((h) => h.top));
      expect(currentBottom).toBeLessThanOrEqual(nextTop);
    }
  });

  it('positions arrow hotspots on alternating sides of the spiral', () => {
    // HOTSPOTS are indexed 0–9 where 0 = stage 10, 9 = stage 1. Even
    // (Divine-Feminine) stages return along the left; odd stages point right.
    HOTSPOTS.forEach((spots, index) => {
      const stageNumber = STAGE_COUNT - index;
      const arrow = spots[0]!;
      if (stageNumber % 2 === 0) {
        expect(arrow.left).toBeLessThan(SIDE_SPLIT);
      } else {
        expect(arrow.left).toBeGreaterThan(SIDE_SPLIT);
      }
    });
  });

  it('exports STAGE_COUNT as 10', () => {
    expect(STAGE_COUNT).toBe(10);
  });
});
