/* eslint-env jest */
/* global describe, it, expect */
import { HOTSPOTS, STAGE_COUNT } from '../stageData';

describe('stageData', () => {
  it('provides hotspots for all stages', () => {
    expect(HOTSPOTS).toHaveLength(STAGE_COUNT);
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
    // HOTSPOTS are indexed 0–9 where 0 = stage 10, 9 = stage 1
    HOTSPOTS.forEach((spots, index) => {
      const stageNumber = STAGE_COUNT - index;
      const arrowSpots = spots.slice(1);
      if (stageNumber === 9) {
        expect(arrowSpots).toHaveLength(2);
      } else {
        expect(arrowSpots).toHaveLength(1);
        const arrow = arrowSpots[0]!;
        if (stageNumber % 2 === 0) {
          expect(arrow.left).toBeLessThan(40);
        } else {
          expect(arrow.left).toBeGreaterThan(40);
        }
      }
    });
  });

  it('exports STAGE_COUNT as 10', () => {
    expect(STAGE_COUNT).toBe(10);
  });
});
