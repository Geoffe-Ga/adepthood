/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { formatReviewPeriod, sourceAttribution, sourceDateLabel } from '../reflectionCopy';

import type { ReflectionSourceItem } from '@/api';

/**
 * The dates this panel PRINTS must read in the account's own IANA zone — the one
 * the server windowed the feed on. Rendering them in the device's zone instead
 * can show a day boundary the feed beneath disagrees with, which is the same
 * two-clocks defect #2886 closed at the data layer (#2892 review).
 *
 * Every case below passes an EXPLICIT zone on both sides, so the assertions hold
 * whatever zone the test runner happens to be in.
 */
describe('reflection date labels read in the account timezone', () => {
  // 15:00Z is the previous calendar day in UTC and the next one in Tokyo (UTC+9),
  // so any assertion built on it fails if the wrong zone is used.
  const TOKYO_MIDNIGHT_JUN_1 = '2026-05-31T15:00:00Z';
  const TOKYO_MIDNIGHT_JUN_8 = '2026-06-07T15:00:00Z';

  const item = (timestamp: string, title: string | null): ReflectionSourceItem => ({
    kind: 'entry',
    id: 1,
    title,
    timestamp,
    body: 'body',
    reflection_level: null,
    promoted_quotes: [],
  });

  it('formatReviewPeriod names the account calendar days, not the UTC ones', () => {
    expect(formatReviewPeriod(TOKYO_MIDNIGHT_JUN_1, TOKYO_MIDNIGHT_JUN_8, 'Asia/Tokyo')).toBe(
      'Jun 1 – Jun 7, 2026',
    );
  });

  it('formatReviewPeriod shifts with the zone it is given', () => {
    expect(formatReviewPeriod(TOKYO_MIDNIGHT_JUN_1, TOKYO_MIDNIGHT_JUN_8, 'UTC')).toBe(
      'May 31 – Jun 6, 2026',
    );
  });

  it('sourceDateLabel reads a crossing instant in the account zone', () => {
    const crossing = item(TOKYO_MIDNIGHT_JUN_1, null);
    expect(sourceDateLabel(crossing, 'Asia/Tokyo')).toBe('Jun 1, 2026');
    expect(sourceDateLabel(crossing, 'UTC')).toBe('May 31, 2026');
  });

  it('leaves sourceAttribution alone, because its output is written into journal text', () => {
    // sourceAttribution composes the attribution line saved INTO a reflection
    // body (useReflectionMode). It takes no zone on purpose: changing it would
    // rewrite stored journal text, not just what is on screen.
    expect(sourceAttribution(item(TOKYO_MIDNIGHT_JUN_1, 'A titled source'))).toBe(
      'A titled source',
    );
  });

  it('returns no label rather than a wrong one when a bound is unparseable', () => {
    expect(formatReviewPeriod('not-a-date', TOKYO_MIDNIGHT_JUN_8, 'Asia/Tokyo')).toBe('');
  });
});
