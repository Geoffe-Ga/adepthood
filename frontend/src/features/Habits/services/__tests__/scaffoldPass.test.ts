import { describe, expect, it } from '@jest/globals';

import type { Habit } from '../../Habits.types';
import { scaffoldOpensPass, type ScaffoldPassState } from '../scaffoldPass';

/** A habit the server issued: what shows an earlier save already happened. */
const serverHabit = { id: 7, name: 'Morning walk' } as Habit;

const FIRST_CYCLE_BEGUN: ScaffoldPassState = {
  programStartLocked: false,
  pendingPassStartsOn: null,
  daysUntilStart: 0,
};
const NOT_YET_BEGUN_DAYS = 10;

describe('scaffoldOpensPass (#3728)', () => {
  it('corrects pass 1 on a first-cycle first save, with no habits on the server', () => {
    expect(scaffoldOpensPass(FIRST_CYCLE_BEGUN, [])).toBe(false);
  });

  it('opens a pass once the server holds habits from an earlier save', () => {
    expect(scaffoldOpensPass(FIRST_CYCLE_BEGUN, [serverHabit])).toBe(true);
  });

  it('opens a pass in a later cycle and while one is pending, habits or not', () => {
    expect(scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, programStartLocked: true }, [])).toBe(true);
    expect(scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, pendingPassStartsOn: '2026-12-01' }, [])).toBe(
      true,
    );
  });

  it('still corrects a first pass that has not begun, even with habits on the server', () => {
    // Opening a pass there could start one on the very day the unbegun pass
    // does: a pass that ran no days. Until it begins, a save moves its start.
    expect(
      scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, daysUntilStart: NOT_YET_BEGUN_DAYS }, [
        serverHabit,
      ]),
    ).toBe(false);
  });

  it('a pending pass outranks the countdown: saving replaces the held day', () => {
    expect(
      scaffoldOpensPass(
        {
          ...FIRST_CYCLE_BEGUN,
          daysUntilStart: NOT_YET_BEGUN_DAYS,
          pendingPassStartsOn: '2026-12-01',
        },
        [serverHabit],
      ),
    ).toBe(true);
  });
});
