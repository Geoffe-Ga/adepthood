/**
 * The day boundary, as a duration.
 *
 * Every expected value below is worked out by hand from the zone's UTC offset
 * and written as a literal, never derived from the helper's own constants: a
 * test that recomputes the production formula proves only that the formula is
 * deterministic. The zones are chosen to sit on both sides of UTC, because the
 * regressions recorded at `dateUtils.ts:114-125` were all sign errors that a
 * UTC-only or west-only fixture would have passed.
 */
import { describe, expect, it } from '@jest/globals';

import { dayKeyInTZ, msUntilNextDayInTZ } from '../dateUtils';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 2026-02-10T05:30:00Z — deep in February, so no northern zone is on DST. */
const WINTER_INSTANT = new Date('2026-02-10T05:30:00.000Z');

describe('msUntilNextDayInTZ — zones east of UTC', () => {
  it('counts to the next Tokyo midnight (UTC+9), 14:30 local', () => {
    // 05:30Z is 14:30 on the 10th in Tokyo; the 11th begins at 15:00Z.
    expect(msUntilNextDayInTZ('Asia/Tokyo', WINTER_INSTANT)).toBe(9 * HOUR + 30 * MINUTE);
  });

  it('counts to the next Kiritimati midnight (UTC+14), the earliest zone on earth', () => {
    // 05:30Z is 19:30 on the 10th at UTC+14; the 11th begins at 10:00Z.
    expect(msUntilNextDayInTZ('Pacific/Kiritimati', WINTER_INSTANT)).toBe(4 * HOUR + 30 * MINUTE);
  });

  it('counts to the next Kathmandu midnight (UTC+5:45), a sub-hour offset', () => {
    // 05:30Z is 11:15 on the 10th in Kathmandu; the 11th begins at 18:15Z.
    expect(msUntilNextDayInTZ('Asia/Kathmandu', WINTER_INSTANT)).toBe(12 * HOUR + 45 * MINUTE);
  });
});

describe('msUntilNextDayInTZ — zones west of UTC', () => {
  it('counts to the next Los Angeles midnight (UTC-8), still on the previous date', () => {
    // 05:30Z is 21:30 on the 9th in Los Angeles; the 10th begins at 08:00Z.
    expect(msUntilNextDayInTZ('America/Los_Angeles', WINTER_INSTANT)).toBe(2 * HOUR + 30 * MINUTE);
  });

  it('counts to the next Midway midnight (UTC-11), the latest zone on earth', () => {
    // 05:30Z is 18:30 on the 9th at UTC-11; the 10th begins at 11:00Z.
    expect(msUntilNextDayInTZ('Pacific/Midway', WINTER_INSTANT)).toBe(5 * HOUR + 30 * MINUTE);
  });

  it('counts to the next UTC midnight for the default zone', () => {
    expect(msUntilNextDayInTZ('UTC', WINTER_INSTANT)).toBe(18 * HOUR + 30 * MINUTE);
  });

  it('falls back to UTC rather than throwing on a malformed zone', () => {
    expect(msUntilNextDayInTZ('Not/AZone', WINTER_INSTANT)).toBe(18 * HOUR + 30 * MINUTE);
  });
});

describe('msUntilNextDayInTZ — daylight saving', () => {
  it('uses the offset in force after a spring-forward, not the one before it', () => {
    // Los Angeles springs forward 2026-03-08 02:00 PST -> 03:00 PDT. At 20:00Z
    // on the 8th it is 13:00 PDT (UTC-7), so the 9th begins at 2026-03-09T07:00Z
    // — eleven hours away. Reading the pre-transition UTC-8 offset would say
    // twelve.
    const afterSpringForward = new Date('2026-03-08T20:00:00.000Z');

    expect(msUntilNextDayInTZ('America/Los_Angeles', afterSpringForward)).toBe(11 * HOUR);
  });

  it('uses the offset in force before a fall-back, not the one after it', () => {
    // Los Angeles falls back 2026-11-01 02:00 PDT -> 01:00 PST. At 20:00Z on
    // 2026-10-31 it is 13:00 PDT (UTC-7), so 2026-11-01 begins at 07:00Z —
    // eleven hours away, not the ten the post-transition UTC-8 offset implies.
    const beforeFallBack = new Date('2026-10-31T20:00:00.000Z');

    expect(msUntilNextDayInTZ('America/Los_Angeles', beforeFallBack)).toBe(11 * HOUR);
  });

  it('lands on the real first instant of a day whose local midnight never happens', () => {
    // Santiago starts DST at 2026-09-05 24:00, so 2026-09-06 00:00 local does
    // not exist: 03:59:00Z is 23:59 on the 5th (UTC-4) and 04:00:00Z is
    // 01:00 on the 6th (UTC-3). The boundary is 04:00Z, an hour later than
    // naive "midnight minus the offset" arithmetic puts it.
    const eveningBefore = new Date('2026-09-06T02:30:00.000Z');

    expect(msUntilNextDayInTZ('America/Santiago', eveningBefore)).toBe(90 * MINUTE);
  });
});

describe('msUntilNextDayInTZ — the property the display depends on', () => {
  const ZONES = [
    'UTC',
    'Asia/Tokyo',
    'Pacific/Kiritimati',
    'Asia/Kathmandu',
    'America/Los_Angeles',
    'Pacific/Midway',
    'America/Santiago',
    'Australia/Lord_Howe',
  ];

  it.each(ZONES)('waiting the returned delay lands in a later calendar day in %s', (zone) => {
    const now = new Date('2026-09-06T02:30:17.250Z');
    const delay = msUntilNextDayInTZ(zone, now);

    const atBoundary = new Date(now.getTime() + delay);
    const justBefore = new Date(now.getTime() + delay - 1);

    expect(dayKeyInTZ(justBefore, zone)).toBe(dayKeyInTZ(now, zone));
    expect(dayKeyInTZ(atBoundary, zone) > dayKeyInTZ(now, zone)).toBe(true);
  });

  it('is strictly positive even a millisecond before the boundary', () => {
    const now = new Date('2026-02-09T23:59:59.999Z');

    expect(msUntilNextDayInTZ('UTC', now)).toBe(1);
  });
});
