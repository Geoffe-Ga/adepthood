import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { PROGRAM_START_BACKDATE_WINDOW_DAYS, TOTAL_PROGRAM_DAYS } from '../../../constants/program';
import { todayInUserTZ } from '../../../utils/dateUtils';
import {
  notAfterLatest,
  passStartRange,
  pickerFloor,
  programStartRange,
  scaffoldOpeningDay,
} from '../programStartRange';

const ZONE = 'America/New_York';
// 02:00 UTC on Nov 9 is still Nov 8 in New York.
const NOW = new Date('2026-11-09T02:00:00Z');

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('programStartRange', () => {
  it('mirrors the backend window constant: one whole program', () => {
    expect(PROGRAM_START_BACKDATE_WINDOW_DAYS).toBe(TOTAL_PROGRAM_DAYS);
  });

  it('ends today in the person zone when no server window is known', () => {
    // todayInUserTZ is the day the rollover owner reports for the zone.
    expect(programStartRange(null, false, todayInUserTZ(ZONE), ZONE).maxDay).toBe('2026-11-08');
  });

  it('takes both ends from the server window when it has one, future days included (#3728)', () => {
    const range = programStartRange(
      { earliest: '2026-01-02', latest: '2027-07-18' },
      false,
      todayInUserTZ(ZONE),
      ZONE,
    );
    expect(range).toEqual({
      minDay: '2026-01-02',
      maxDay: '2027-07-18',
      today: '2026-11-08',
      locked: false,
    });
  });

  it('falls back to today minus the window when no server window is known', () => {
    expect(programStartRange(null, false, todayInUserTZ(ZONE), ZONE).minDay).toBe('2026-03-01');
  });

  it('carries the lock through', () => {
    expect(programStartRange(null, true, todayInUserTZ(ZONE), ZONE).locked).toBe(true);
  });
});

describe('passStartRange (#3728)', () => {
  const TODAY = '2026-11-08';

  it('is the served pass window, never locked, in any cycle', () => {
    expect(passStartRange({ earliest: '2026-09-13', latest: '2027-07-18' }, TODAY)).toEqual({
      minDay: '2026-09-13',
      maxDay: '2027-07-18',
      today: TODAY,
      locked: false,
    });
  });

  it('offers only today when no pass window has been served', () => {
    // Today is never before the running pass and never past the ceiling, so it
    // is the one day the client can offer without computing a window itself.
    expect(passStartRange(null, TODAY)).toEqual({
      minDay: TODAY,
      maxDay: TODAY,
      today: TODAY,
      locked: false,
    });
  });
});

describe('notAfterLatest', () => {
  const range = { maxDay: '2027-07-18' };

  it.each([
    ['2027-12-01', '2027-07-18'],
    ['2026-12-01', '2026-12-01'],
    ['2025-01-01', '2025-01-01'],
    ['2027-07-18', '2027-07-18'],
  ])('opens %s on %s', (day, expected) => {
    expect(notAfterLatest(day, range)).toBe(expected);
  });
});

describe('scaffoldOpeningDay (#3728)', () => {
  const range = { minDay: '2026-09-13', maxDay: '2027-07-18', today: '2026-11-08', locked: false };

  it('opens on today when no pass is held', () => {
    expect(scaffoldOpeningDay(null, range)).toBe('2026-11-08');
  });

  it('opens on the held pending day, so saving again keeps it unless changed', () => {
    expect(scaffoldOpeningDay('2026-12-01', range)).toBe('2026-12-01');
  });

  it('is pulled inside the window from either side', () => {
    expect(scaffoldOpeningDay('2028-01-01', range)).toBe('2027-07-18');
    expect(scaffoldOpeningDay(null, { ...range, minDay: '2026-11-20' })).toBe('2026-11-20');
  });
});

describe('pickerFloor', () => {
  it('is the range floor for a day inside it', () => {
    expect(pickerFloor({ minDay: '2026-03-01' }, '2026-06-01')).toBe('2026-03-01');
  });

  it('reaches down to a held day below it, so the picker can give it back', () => {
    expect(pickerFloor({ minDay: '2026-03-01' }, '2026-01-15')).toBe('2026-01-15');
  });
});
