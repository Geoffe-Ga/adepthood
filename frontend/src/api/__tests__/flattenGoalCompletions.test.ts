/* eslint-env jest */
/* global describe, it, expect */
import { flattenGoalCompletions } from '../flattenGoalCompletions';

describe('flattenGoalCompletions', () => {
  it('returns an empty array when given no goals', () => {
    expect(flattenGoalCompletions([])).toEqual([]);
  });

  it('returns an empty array when goals carry no completions', () => {
    expect(flattenGoalCompletions([{}, { completions: [] }, { completions: null }])).toEqual([]);
  });

  it('flattens completions across goals and rehydrates timestamps to Date', () => {
    const flat = flattenGoalCompletions([
      { completions: [{ id: 1, timestamp: '2026-05-09T22:00:00Z', completed_units: 2 }] },
      { completions: [{ id: 2, timestamp: '2026-05-10T08:00:00Z', completed_units: 3 }] },
    ]);
    expect(flat).toHaveLength(2);
    expect(flat[0]!.id).toBe('1');
    expect(flat[0]!.timestamp).toBeInstanceOf(Date);
    expect(flat[0]!.timestamp.getTime()).not.toBeNaN();
    expect(flat[1]!.completed_units).toBe(3);
  });

  it('dedupes by row id when the same completion appears under multiple goals', () => {
    // Defends future shared-goal scenarios where one row surfaces under multiple tiers.
    const flat = flattenGoalCompletions([
      { completions: [{ id: 7, timestamp: '2026-05-09T22:00:00Z', completed_units: 1 }] },
      { completions: [{ id: 7, timestamp: '2026-05-09T22:00:00Z', completed_units: 1 }] },
    ]);
    expect(flat).toHaveLength(1);
  });
});
