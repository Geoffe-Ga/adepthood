import { describe, expect, it } from '@jest/globals';

import { instantAt } from '../e2e/zonedClock';

/**
 * The browser lane's zoned wall clock (#2771). The day-rollover journey sets
 * the page's fake clock to a wall time on the day the SERVER recorded a
 * completion for, in the account's zone -- so the arithmetic that turns
 * "23:58 on that day in Los Angeles" into an instant has to be right on both
 * sides of a DST change, or the spec crosses the wrong midnight. A live page
 * cannot be made to sit on a DST boundary on demand; these pin it instead.
 */

const LOS_ANGELES = 'America/Los_Angeles';

describe('instantAt', () => {
  it('reads a winter wall time at the PST offset', () => {
    expect(instantAt('2026-02-10', '23:58', LOS_ANGELES).toISOString()).toBe(
      '2026-02-11T07:58:00.000Z',
    );
  });

  it('reads a summer wall time at the PDT offset', () => {
    expect(instantAt('2026-07-10', '23:58', LOS_ANGELES).toISOString()).toBe(
      '2026-07-11T06:58:00.000Z',
    );
  });

  it('resolves both sides of the day the clocks spring forward', () => {
    expect(instantAt('2026-03-08', '01:30', LOS_ANGELES).toISOString()).toBe(
      '2026-03-08T09:30:00.000Z',
    );
    // Read naively as UTC, 03:30 still falls before the change; only a second
    // look at the answer finds the summer offset that actually applies.
    expect(instantAt('2026-03-08', '03:30', LOS_ANGELES).toISOString()).toBe(
      '2026-03-08T10:30:00.000Z',
    );
    expect(instantAt('2026-03-08', '23:58', LOS_ANGELES).toISOString()).toBe(
      '2026-03-09T06:58:00.000Z',
    );
  });

  it('is the identity on UTC', () => {
    expect(instantAt('2026-10-02', '12:00', 'UTC').toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });

  it('refuses a wall time it cannot read', () => {
    expect(() => instantAt('2026-02-10', '25:00', LOS_ANGELES)).toThrow('wall time');
    expect(() => instantAt('2026-02-10', 'noon', LOS_ANGELES)).toThrow('wall time');
    expect(() => instantAt('2026-2-10', '12:00', LOS_ANGELES)).toThrow('day key');
  });
});
