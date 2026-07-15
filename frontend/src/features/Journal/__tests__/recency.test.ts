/* eslint-env jest */
// Recency bucketing + absolute-date formatting shared by the shelf and its
// header drawer. These pin the recency bands and the malformed-timestamp
// handling so an unparseable API date buckets deterministically.
import { describe, expect, it } from '@jest/globals';

import type { JournalMessage } from '@/api';
import { formatDate, groupByRecency } from '@/features/Journal/recency';

const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

function entry(id: number, timestamp: string): JournalMessage {
  return {
    id,
    message: `Body of entry ${id}.`,
    sender: 'user',
    timestamp,
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
  };
}

describe('groupByRecency', () => {
  it('sorts entries into This week / This month / Earlier bands', () => {
    const now = Date.now();
    const sections = groupByRecency([entry(1, ago(1)), entry(2, ago(10)), entry(3, ago(60))], now);

    expect(sections.map((s) => s.title)).toEqual(['This week', 'This month', 'Earlier']);
    expect(sections.map((s) => s.data[0]?.id)).toEqual([1, 2, 3]);
  });

  it('drops bands that have no entries', () => {
    const now = Date.now();
    const sections = groupByRecency([entry(1, ago(1))], now);

    expect(sections.map((s) => s.title)).toEqual(['This week']);
  });

  it('buckets an unparseable timestamp into Earlier rather than by NaN accident', () => {
    const now = Date.now();
    const sections = groupByRecency([entry(1, 'not-a-date')], now);

    expect(sections.map((s) => s.title)).toEqual(['Earlier']);
    expect(sections[0]?.data[0]?.id).toBe(1);
  });
});

describe('formatDate', () => {
  it('renders an absolute Month D, YYYY label', () => {
    expect(formatDate('2024-03-05T12:00:00.000Z')).toContain('2024');
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});
