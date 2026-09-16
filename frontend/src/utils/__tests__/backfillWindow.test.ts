/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { dayWindowVerdict } from '../backfillWindow';

/**
 * The client half of the backfill window the server owns.
 *
 * `backend/src/domain/dates.py:day_window_verdict` decides how far back a
 * completion may be logged, and `backend/src/routers/journal.py` silently
 * substitutes today for any suggestion day it refuses. A card that promises a
 * day the accept would refuse mis-states what pressing OK does, so this table
 * pins the same three-valued answer on the same boundaries — both endpoints
 * inclusive, exactly as the Python docstring says.
 */
const TODAY = '2026-09-12';

describe('dayWindowVerdict', () => {
  it('accepts today itself', () => {
    expect(dayWindowVerdict(TODAY, TODAY)).toBe('ok');
  });

  it('accepts yesterday', () => {
    expect(dayWindowVerdict('2026-09-11', TODAY)).toBe('ok');
  });

  it('accepts the oldest day still inside the window', () => {
    // today - 30, inclusive: 2026-09-12 minus 30 days.
    expect(dayWindowVerdict('2026-08-13', TODAY)).toBe('ok');
  });

  it('refuses the day one step beyond the window', () => {
    expect(dayWindowVerdict('2026-08-12', TODAY)).toBe('too_old');
  });

  it('refuses tomorrow as future', () => {
    expect(dayWindowVerdict('2026-09-13', TODAY)).toBe('future');
  });

  it('refuses a day far in the future', () => {
    expect(dayWindowVerdict('2027-01-01', TODAY)).toBe('future');
  });

  it('crosses a month boundary without arithmetic drift', () => {
    expect(dayWindowVerdict('2026-02-28', '2026-03-01')).toBe('ok');
    expect(dayWindowVerdict('2025-12-31', '2026-01-01')).toBe('ok');
  });
});
