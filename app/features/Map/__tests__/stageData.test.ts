/* eslint-env jest */
/* global describe, it, expect */
import { STAGES } from '../stageData';

describe('stageData', () => {
  it('orders stages from 10 at top to 1 at bottom', () => {
    expect(STAGES[0]!.stageNumber).toBe(10);
    expect(STAGES[STAGES.length - 1]!.stageNumber).toBe(1);
  });

  it('has non-overlapping vertical hotspot ranges', () => {
    for (let i = 0; i < STAGES.length - 1; i++) {
      const current = STAGES[i]!;
      const next = STAGES[i + 1]!;
      const currentBottom = Math.max(...current.hotspots.map((h) => h.top + h.height));
      const nextTop = Math.min(...next.hotspots.map((h) => h.top));
      expect(currentBottom).toBeLessThanOrEqual(nextTop);
    }
  });

  it('positions arrow hotspots on alternating sides of the spiral', () => {
    STAGES.forEach((stage) => {
      const arrowSpots = stage.hotspots.slice(1);
      if (stage.stageNumber === 9) {
        expect(arrowSpots).toHaveLength(2);
      } else {
        expect(arrowSpots).toHaveLength(1);
        const arrow = arrowSpots[0]!;
        if (stage.stageNumber % 2 === 0) {
          expect(arrow.left).toBeLessThan(40);
        } else {
          expect(arrow.left).toBeGreaterThan(40);
        }
      }
    });
  });
});
