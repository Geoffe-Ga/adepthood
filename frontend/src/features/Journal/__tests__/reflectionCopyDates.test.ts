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

  it('reads a UTC window in UTC, so the same label comes from different instants', () => {
    // REWRITTEN (#2892 review): this used to feed the Tokyo-midnight instants above
    // and read them as UTC, asserting 'May 31 - Jun 6'. But 15:00Z is not a local
    // midnight in UTC, so the function's "exclusive end is a local midnight"
    // precondition never held and the expected value was simply whatever a 24-hour
    // step produced -- an artifact of the arithmetic, not a fact about the label.
    // A genuine UTC window covers the same calendar days as the Tokyo one above
    // from seven hours' different instants, which is the real claim worth pinning.
    expect(formatReviewPeriod('2026-06-01T00:00:00Z', '2026-06-08T00:00:00Z', 'UTC')).toBe(
      'Jun 1 – Jun 7, 2026',
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

  it('names the last day correctly when it is a spring-forward day', () => {
    // America/Los_Angeles springs forward on 2026-03-08, making that day 23 hours
    // long. A review whose last covered day IS that day ends at local midnight on
    // the 9th (07:00Z, already PDT). Stepping back a full 24h from there lands at
    // 2026-03-08T07:00Z -- still PST, i.e. 23:00 on the 7th -- and the label would
    // read a day short. The backend windows this period on real local midnights;
    // the label has to agree with it (#2892 review).
    expect(
      formatReviewPeriod('2026-03-02T08:00:00Z', '2026-03-09T07:00:00Z', 'America/Los_Angeles'),
    ).toBe('Mar 2 – Mar 8, 2026');
  });

  it('names the last day correctly when it is a fall-back day', () => {
    // The mirror: 2026-11-01 is 25 hours long in America/Los_Angeles.
    expect(
      formatReviewPeriod('2026-10-26T07:00:00Z', '2026-11-02T08:00:00Z', 'America/Los_Angeles'),
    ).toBe('Oct 26 – Nov 1, 2026');
  });

  it('returns no label rather than a wrong one when a bound is unparseable', () => {
    expect(formatReviewPeriod('not-a-date', TOKYO_MIDNIGHT_JUN_8, 'Asia/Tokyo')).toBe('');
  });
});
