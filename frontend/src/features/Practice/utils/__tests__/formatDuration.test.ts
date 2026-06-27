import { describe, expect, it } from '@jest/globals';

import { formatDuration } from '../formatDuration';

describe('formatDuration', () => {
  it('renders whole minutes with the "min" unit', () => {
    expect(formatDuration(10)).toBe('10 min');
    expect(formatDuration(1)).toBe('1 min');
    expect(formatDuration(0)).toBe('0 min');
  });

  it('rounds fractional minutes to the nearest whole minute', () => {
    expect(formatDuration(9.4)).toBe('9 min');
    expect(formatDuration(9.6)).toBe('10 min');
  });
});
