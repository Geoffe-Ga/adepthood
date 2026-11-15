import { describe, expect, it } from '@jest/globals';

import { pickPromoteTarget, type RowExtent } from '../promoteTarget';

const VIEWPORT = { top: 1000, height: 600 } as const;

function extents(entries: Record<string, RowExtent>): ReadonlyMap<string, RowExtent> {
  return new Map(Object.entries(entries));
}

describe('pickPromoteTarget (#3718)', () => {
  it('names no target when nothing is expanded', () => {
    expect(pickPromoteTarget([], extents({ a: { top: 0, height: 5000 } }), VIEWPORT)).toBeNull();
  });

  it('falls back to the most recently expanded row before anything is measured', () => {
    expect(pickPromoteTarget(['a', 'b'], new Map(), null)).toBe('b');
    expect(pickPromoteTarget(['a', 'b'], new Map(), VIEWPORT)).toBe('b');
  });

  it('picks the expanded row covering the most of the viewport', () => {
    const rows = extents({
      a: { top: 0, height: 1200 }, // 200px in view
      b: { top: 1200, height: 2000 }, // 400px in view
    });
    expect(pickPromoteTarget(['a', 'b'], rows, VIEWPORT)).toBe('b');
  });

  it('ignores a collapsed row however much of the viewport it fills', () => {
    const rows = extents({
      a: { top: 0, height: 1100 }, // 100px in view, expanded
      b: { top: 1100, height: 3000 }, // fills the rest, collapsed
    });
    expect(pickPromoteTarget(['a'], rows, VIEWPORT)).toBe('a');
  });

  it('names no target when every expanded row has scrolled out of view', () => {
    const rows = extents({ a: { top: 0, height: 900 }, b: { top: 1700, height: 300 } });
    expect(pickPromoteTarget(['a', 'b'], rows, VIEWPORT)).toBeNull();
  });

  it('a row that only touches the viewport edge is not in view', () => {
    expect(pickPromoteTarget(['a'], extents({ a: { top: 0, height: 1000 } }), VIEWPORT)).toBeNull();
  });

  it('breaks a tie toward the row expanded last', () => {
    const rows = extents({ a: { top: 1000, height: 300 }, b: { top: 1300, height: 300 } });
    expect(pickPromoteTarget(['a', 'b'], rows, VIEWPORT)).toBe('b');
    expect(pickPromoteTarget(['b', 'a'], rows, VIEWPORT)).toBe('a');
  });
});
