/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { COLUMN_TOP, MarginSlotInputError, computeMarginSlots } from '../computeMarginSlots';
import type { MarginAnchorTop } from '../computeMarginSlots';

/** Mirrors journalLayout.marginNoteGap (frontend/src/design/tokens.ts:505) without importing tokens. */
const GAP = 16;

/** The anchored items of one fixture, paired with the tops the solver gave them. */
interface AnchoredRow {
  anchor: number;
  height: number;
  top: number;
}

function anchoredRows(
  anchors: readonly MarginAnchorTop[],
  heights: readonly number[],
  tops: readonly number[],
): AnchoredRow[] {
  const rows: AnchoredRow[] = [];
  for (const [index, anchor] of anchors.entries()) {
    if (anchor === null || anchor === undefined) continue;
    rows.push({ anchor, height: heights[index] ?? Number.NaN, top: tops[index] ?? Number.NaN });
  }
  return rows;
}

const FIXTURES: { anchors: MarginAnchorTop[]; heights: number[] }[] = [
  { anchors: [0, 60, 120], heights: [40, 20, 30] },
  { anchors: [0, 10], heights: [40, 20] },
  { anchors: [0, 10, 60], heights: [40, 20, 20] },
  { anchors: [50, 50], heights: [30, 30] },
  { anchors: [0, null, 40, undefined, null], heights: [20, 10, 30, 12, 8] },
  { anchors: [0, 5, 10, 200, 205], heights: [90, 5, 60, 5, 40] },
];

describe('computeMarginSlots -- identity when nothing collides', () => {
  it('leaves two non-colliding notes at their anchors', () => {
    expect(computeMarginSlots([0, 100], [40, 20], GAP)).toEqual([0, 100]);
  });

  it('leaves three non-colliding notes at their anchors', () => {
    expect(computeMarginSlots([0, 60, 120], [40, 20, 30], GAP)).toEqual([0, 60, 120]);
  });

  it('does not clamp a negative first anchor up to the column top', () => {
    expect(computeMarginSlots([-10, 100], [40, 20], GAP)).toEqual([-10, 100]);
  });
});

describe('computeMarginSlots -- collision push-down', () => {
  it('pushes a colliding note down to exactly clear the one above by gap', () => {
    expect(computeMarginSlots([0, 10], [40, 20], GAP)).toEqual([0, 56]);
  });

  it('cascades: a note clearing the original span still yields to the pushed span', () => {
    expect(computeMarginSlots([0, 10, 60], [40, 20, 20], GAP)).toEqual([0, 56, 92]);
  });

  it('measures the push from the pushing note own height, not from its anchor', () => {
    expect(computeMarginSlots([0, 30], [100, 20], GAP)).toEqual([0, 116]);
  });

  it('separates two notes that share an anchor', () => {
    expect(computeMarginSlots([50, 50], [30, 30], GAP)).toEqual([50, 96]);
  });

  it('lets a note taller than the column push the next one past it, unclamped', () => {
    expect(computeMarginSlots([0, 20], [10_000, 20], GAP)).toEqual([0, 10_016]);
  });
});

describe('computeMarginSlots -- unanchored items trail the anchored ones', () => {
  it('places an unanchored item after the last anchored item plus gap, in input order', () => {
    expect(computeMarginSlots([null, 0, 10], [12, 40, 20], GAP)).toEqual([92, 0, 56]);
  });

  it('stacks several unanchored items in creation order, spaced by gap', () => {
    expect(computeMarginSlots([0, null, 40, undefined, null], [20, 10, 30, 12, 8], GAP)).toEqual([
      0, 86, 40, 112, 140,
    ]);
  });

  it('starts the tail at the column top when nothing is anchored', () => {
    expect(computeMarginSlots([null, null], [10, 20], GAP)).toEqual([
      COLUMN_TOP,
      COLUMN_TOP + 10 + GAP,
    ]);
  });

  it('treats an undefined anchor exactly like a null one', () => {
    expect(computeMarginSlots([undefined, 0], [10, 20], GAP)).toEqual(
      computeMarginSlots([null, 0], [10, 20], GAP),
    );
    expect(computeMarginSlots([undefined, 0], [10, 20], GAP)).toEqual([36, 0]);
  });
});

describe('computeMarginSlots -- degenerate inputs', () => {
  it('returns an empty column for no items', () => {
    expect(computeMarginSlots([], [], GAP)).toEqual([]);
  });

  it('leaves a lone note at its anchor', () => {
    expect(computeMarginSlots([37], [20], GAP)).toEqual([37]);
  });

  it('keeps input order when anchors arrive out of document order', () => {
    expect(computeMarginSlots([100, 0], [10, 10], GAP)).toEqual([100, 126]);
  });
});

describe('computeMarginSlots -- document-order invariant', () => {
  it.each(FIXTURES)('keeps document order for %j', ({ anchors, heights }) => {
    const tops = computeMarginSlots(anchors, heights, GAP);

    expect(tops).toHaveLength(anchors.length);

    const rows = anchoredRows(anchors, heights, tops);
    for (const [index, row] of rows.entries()) {
      expect(row.top).toBeGreaterThanOrEqual(row.anchor);
      for (const later of rows.slice(index + 1)) {
        expect(later.top).toBeGreaterThanOrEqual(row.top + row.height + GAP);
        expect(later.top).toBeGreaterThanOrEqual(row.top);
      }
    }
  });
});

describe('computeMarginSlots -- purity and totality', () => {
  it('returns deep-equal results for equal inputs', () => {
    const first = computeMarginSlots([0, 10, null], [40, 20, 12], GAP);
    const second = computeMarginSlots([0, 10, null], [40, 20, 12], GAP);

    expect(first).toEqual(second);
  });

  it('accepts frozen inputs and does not mutate them', () => {
    const anchors = Object.freeze([0, 10, null]);
    const heights = Object.freeze([40, 20, 12]);

    expect(computeMarginSlots(anchors, heights, GAP)).toEqual([0, 56, 92]);
    expect(anchors).toEqual([0, 10, null]);
    expect(heights).toEqual([40, 20, 12]);
  });

  it('throws when there are more anchors than heights', () => {
    expect(() => computeMarginSlots([0, 10], [40], GAP)).toThrow(MarginSlotInputError);
    expect(() => computeMarginSlots([0, 10], [40], GAP)).toThrow(
      /2 anchor tops but 1 note heights/,
    );
  });

  it('throws when there are more heights than anchors', () => {
    expect(() => computeMarginSlots([0], [40, 20], GAP)).toThrow(MarginSlotInputError);
    expect(() => computeMarginSlots([0], [40, 20], GAP)).toThrow(
      /1 anchor tops but 2 note heights/,
    );
  });
});
