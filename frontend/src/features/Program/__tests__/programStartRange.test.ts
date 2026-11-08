import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { PROGRAM_START_BACKDATE_WINDOW_DAYS, TOTAL_PROGRAM_DAYS } from '../../../constants/program';
import { todayInUserTZ } from '../../../utils/dateUtils';
import { notAfterToday, pickerFloor, programStartRange } from '../programStartRange';

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

  it('ends today in the person zone, never the device or UTC date', () => {
    // todayInUserTZ is the day the rollover owner reports for the zone.
    expect(programStartRange(null, false, todayInUserTZ(ZONE), ZONE).maxDay).toBe('2026-11-08');
  });

  it('takes the floor from the server window when it has one', () => {
    const range = programStartRange(
      { earliest: '2026-01-02', latest: '2026-11-08' },
      false,
      todayInUserTZ(ZONE),
      ZONE,
    );
    expect(range).toEqual({ minDay: '2026-01-02', maxDay: '2026-11-08', locked: false });
  });

  it('falls back to today minus the window when no server window is known', () => {
    expect(programStartRange(null, false, todayInUserTZ(ZONE), ZONE).minDay).toBe('2026-03-01');
  });

  it('carries the lock through', () => {
    expect(programStartRange(null, true, todayInUserTZ(ZONE), ZONE).locked).toBe(true);
  });
});

describe('notAfterToday', () => {
  const range = { maxDay: '2026-11-08' };

  it.each([
    ['2026-12-01', '2026-11-08'],
    ['2025-01-01', '2025-01-01'],
    ['2026-11-08', '2026-11-08'],
  ])('opens %s on %s', (day, expected) => {
    expect(notAfterToday(day, range)).toBe(expected);
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
