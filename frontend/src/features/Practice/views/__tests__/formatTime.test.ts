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
});
