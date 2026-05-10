/* eslint-env jest */
/* global describe, it, expect */
import { flattenGoalCompletions } from '../flattenGoalCompletions';

// Direct unit tests for the shared helper that ``toLocalHabit``
// (api/index.ts) and ``mapApiHabits`` (features/Habits/services/
// habitManager.ts) both delegate to.  The behavioural contract is
// already exercised through the two callers, but pinning it directly
// here means a regression in the helper surfaces against the helper
// itself rather than getting blamed on the mapper layer above it.

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
    // Defends the future-shared-goal scenario the reviewer flagged on
    // PR #293 -- a single ``GoalCompletion`` row may surface under more
    // than one tier goal and the local habit progress sum must count it
    // exactly once.
    const flat = flattenGoalCompletions([
      { completions: [{ id: 7, timestamp: '2026-05-09T22:00:00Z', completed_units: 1 }] },
      { completions: [{ id: 7, timestamp: '2026-05-09T22:00:00Z', completed_units: 1 }] },
    ]);
    expect(flat).toHaveLength(1);
  });
});
