import { describe, expect, it } from '@jest/globals';

import { formatTotalMinutes } from '../formatTotalMinutes';

/**
 * The issue asks for "total minutes (formatted as hours+minutes past 60)", so
 * the boundary at 60 and the two ways a total can be *exactly* on an hour are
 * the whole of the interesting behaviour.
 */
describe('formatTotalMinutes', () => {
  it('stays in minutes below an hour', () => {
    expect(formatTotalMinutes(0)).toBe('0m');
    expect(formatTotalMinutes(1)).toBe('1m');
    expect(formatTotalMinutes(59)).toBe('59m');
  });

  it('rolls over to hours plus the remainder past 60', () => {
    expect(formatTotalMinutes(60)).toBe('1h');
    expect(formatTotalMinutes(61)).toBe('1h 1m');
    expect(formatTotalMinutes(460)).toBe('7h 40m');
  });

  it('drops the minutes segment only when the total lands on the hour', () => {
    expect(formatTotalMinutes(120)).toBe('2h');
    expect(formatTotalMinutes(121)).toBe('2h 1m');
  });

  it('rounds to whole minutes before splitting, never after', () => {
    // 59.6 rounds to 60, which is an hour -- splitting first would print "0h 60m".
    expect(formatTotalMinutes(59.6)).toBe('1h');
    expect(formatTotalMinutes(60.4)).toBe('1h');
    expect(formatTotalMinutes(90.5)).toBe('1h 31m');
  });

  it('never renders a negative total as a negative duration', () => {
    // The backend cannot produce one (it sums a positive-only population), so a
    // negative here means a malformed payload; showing "-1h 0m" would dress it
    // up as a real reading.
    expect(formatTotalMinutes(-5)).toBe('0m');
  });
});
