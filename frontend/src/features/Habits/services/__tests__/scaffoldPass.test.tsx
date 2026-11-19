import { afterEach, describe, expect, it } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

import { useProgramStore } from '../../../../store/useProgramStore';
import { addDaysInTZ, todayInUserTZ } from '../../../../utils/dateUtils';
import type { Habit } from '../../Habits.types';
import {
  scaffoldOpensPass,
  scaffoldOpensPassNow,
  useScaffoldOpensPass,
  type ScaffoldPassState,
} from '../scaffoldPass';

/** A habit the server issued: what shows an earlier save already happened. */
const serverHabit = { id: 7, name: 'Morning walk' } as Habit;

const TODAY = '2026-11-19';
const YESTERDAY = '2026-11-18';

const FIRST_CYCLE_BEGUN: ScaffoldPassState = {
  programStartLocked: false,
  pendingPassStartsOn: null,
  daysUntilStart: 0,
  programStartDay: YESTERDAY,
};
const NOT_YET_BEGUN_DAYS = 10;

describe('scaffoldOpensPass (#3728)', () => {
  it('corrects pass 1 on a first-cycle first save, with no habits on the server', () => {
    expect(scaffoldOpensPass(FIRST_CYCLE_BEGUN, [], TODAY)).toBe(false);
  });

  it('opens a pass once the server holds habits from an earlier save', () => {
    expect(scaffoldOpensPass(FIRST_CYCLE_BEGUN, [serverHabit], TODAY)).toBe(true);
  });

  it('opens a pass in a later cycle and while one is pending, habits or not', () => {
    expect(scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, programStartLocked: true }, [], TODAY)).toBe(
      true,
    );
    expect(
      scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, pendingPassStartsOn: '2026-12-01' }, [], TODAY),
    ).toBe(true);
  });

  it('still corrects a first pass that has not begun, even with habits on the server', () => {
    // Opening a pass there could start one on the very day the unbegun pass
    // does: a pass that ran no days. Until it begins, a save moves its start.
    expect(
      scaffoldOpensPass(
        { ...FIRST_CYCLE_BEGUN, daysUntilStart: NOT_YET_BEGUN_DAYS },
        [serverHabit],
        TODAY,
      ),
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
        TODAY,
      ),
    ).toBe(true);
  });

  describe('a first pass that began today has run no days', () => {
    const BEGAN_TODAY: ScaffoldPassState = { ...FIRST_CYCLE_BEGUN, programStartDay: TODAY };

    it('corrects it, habits on the server or not: a signup-day scaffold may keep today', () => {
      // Opening a pass would have to start tomorrow (never on the running
      // pass's own start), refusing the very day the person signed up on.
      expect(scaffoldOpensPass(BEGAN_TODAY, [serverHabit], TODAY)).toBe(false);
      expect(scaffoldOpensPass(BEGAN_TODAY, [], TODAY)).toBe(false);
    });

    it('opens a pass once that day is over: the pass has run a day', () => {
      const tomorrow = '2026-11-20';
      expect(scaffoldOpensPass(BEGAN_TODAY, [serverHabit], tomorrow)).toBe(true);
    });

    it('still opens a pass in a later cycle or while one is pending', () => {
      expect(
        scaffoldOpensPass({ ...BEGAN_TODAY, programStartLocked: true }, [serverHabit], TODAY),
      ).toBe(true);
      expect(
        scaffoldOpensPass(
          { ...BEGAN_TODAY, pendingPassStartsOn: '2026-12-01' },
          [serverHabit],
          TODAY,
        ),
      ).toBe(true);
    });

    it('opens a pass when the running start is unknown', () => {
      expect(
        scaffoldOpensPass({ ...FIRST_CYCLE_BEGUN, programStartDay: null }, [serverHabit], TODAY),
      ).toBe(true);
    });
  });
});

describe('the modal and the save read one decision from the store (#3728)', () => {
  const ZONE = 'UTC';

  afterEach(() => {
    useProgramStore.getState().reset();
  });

  it.each([
    ['began today: correct it', 0, false],
    ['began yesterday: open a pass', -1, true],
  ])('a first pass that %s', (_label, offset, opens) => {
    const today = todayInUserTZ(ZONE);
    useProgramStore.getState().setProgramStartDay(addDaysInTZ(today, offset, ZONE));
    const { result } = renderHook(() => useScaffoldOpensPass([serverHabit], ZONE));
    expect(result.current).toBe(opens);
    expect(scaffoldOpensPassNow([serverHabit], ZONE)).toBe(opens);
  });
});
