import { describe, expect, it } from '@jest/globals';

import { HABIT_MODAL_CLOSE_LABELS, MODAL_CLOSE_LABEL } from '../modalCloseLabels';

describe('modalCloseLabels', () => {
  it('names each Habits modal close control distinctly', () => {
    expect(HABIT_MODAL_CLOSE_LABELS).toHaveLength(5);
    expect(new Set(HABIT_MODAL_CLOSE_LABELS).size).toBe(HABIT_MODAL_CLOSE_LABELS.length);
  });

  it('never reuses the default name, which GoalModal backdrop already carries', () => {
    expect(HABIT_MODAL_CLOSE_LABELS).not.toContain(MODAL_CLOSE_LABEL);
  });
});
