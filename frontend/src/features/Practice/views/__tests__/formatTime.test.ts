import { describe, expect, it } from '@jest/globals';

import { formatTime } from '../formatTime';

describe('formatTime', () => {
  it.each<[number, string]>([
    [0, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [59_000, '00:59'],
    [60_000, '01:00'],
    [615_000, '10:15'],
  ])('formats %dms as %s', (ms, expected) => {
    expect(formatTime(ms)).toBe(expected);
  });

  it('clamps negative inputs to 00:00 so late ticks never render negatives', () => {
    expect(formatTime(-5000)).toBe('00:00');
  });

  // Sessions longer than 59:59 spill the minutes column past two digits rather
  // than wrap to 00:00. The view layer relies on this so a 90-minute session
  // displays "90:00" instead of pretending an hour didn't pass. If an
  // hours-aware format is ever needed, this test pins the current contract.
  it('does not wrap minutes above 59 (90 min renders as 90:00)', () => {
    expect(formatTime(90 * 60_000)).toBe('90:00');
    expect(formatTime(125 * 60_000 + 7_000)).toBe('125:07');
  });
});
