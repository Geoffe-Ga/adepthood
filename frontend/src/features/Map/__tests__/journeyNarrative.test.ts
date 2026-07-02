/* eslint-env jest */
/* global describe, it, expect */
import {
  formatMinutes,
  journeyRead,
  progressionSentence,
  rankedStats,
  unlockTimeline,
} from '../journeyNarrative';

import type { StageHistoryResponse } from '@/api';

const HISTORY: StageHistoryResponse = {
  stage_number: 1,
  practices: [
    { name: 'Breath of Fire', sessions_completed: 12, total_minutes: 180, last_session: null },
    { name: 'Box Breath', sessions_completed: 3, total_minutes: 30, last_session: null },
  ],
  habits: [
    {
      name: 'Morning Exercise',
      icon: '🏃',
      goals_achieved: { low: true, clear: true, stretch: false },
      best_streak: 14,
      total_completions: 45,
    },
  ],
};

const EMPTY: StageHistoryResponse = { stage_number: 1, practices: [], habits: [] };

describe('journeyRead', () => {
  it('renders "Stage N of 10 · Week W"', () => {
    expect(journeyRead(5, 12, 10)).toBe('Stage 5 of 10 · Week 12');
  });
});

describe('unlockTimeline', () => {
  it('pluralises day counts', () => {
    expect(unlockTimeline(3)).toBe('Unlocks in 3 days');
    expect(unlockTimeline(1)).toBe('Unlocks in 1 day');
  });

  it('treats zero / negative as unlocking now', () => {
    expect(unlockTimeline(0)).toBe('Unlocking now');
    expect(unlockTimeline(-2)).toBe('Unlocking now');
  });

  it('falls back to the condition when no anchor is set', () => {
    expect(unlockTimeline(null)).toContain('reaches it');
  });
});

describe('progressionSentence', () => {
  it('reads as one sentence with sessions and a streak', () => {
    const sentence = progressionSentence(HISTORY);
    expect(sentence).toBe('You logged 15 sessions across 2 practices and held a 14-day streak.');
  });

  it('falls back to a beginning-of-story line when empty', () => {
    expect(progressionSentence(EMPTY)).toContain('just beginning');
  });
});

describe('rankedStats', () => {
  it('ranks headline stats largest-first and drops zeros', () => {
    const stats = rankedStats(HISTORY);
    // 15 sessions, 3 hours (210 min → 4 rounded), 14-day streak; all > 0.
    expect(stats.map((s) => s.key)).toEqual(['sessions', 'streak', 'minutes']);
    expect(stats[0]).toEqual({ key: 'sessions', label: 'Sessions', value: 15 });
  });

  it('returns nothing for an empty history', () => {
    expect(rankedStats(EMPTY)).toEqual([]);
  });
});

describe('formatMinutes', () => {
  it('renders whole minutes with the "min" unit under an hour', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(59)).toBe('59 min');
    expect(formatMinutes(45)).toBe('45 min');
  });

  it('rounds fractional minutes under an hour to the nearest whole minute', () => {
    expect(formatMinutes(59.4)).toBe('59 min');
  });

  it('switches to hours at the 60-minute boundary, singular at exactly 1 hour', () => {
    expect(formatMinutes(60)).toBe('1 hr');
  });

  it('rounds minutes-to-hours and pluralises once the rounded value is not 1', () => {
    expect(formatMinutes(90)).toBe('2 hrs'); // 1.5 rounds up to 2
    expect(formatMinutes(120)).toBe('2 hrs');
  });

  it('stays singular when the rounded hour count is still 1', () => {
    expect(formatMinutes(89)).toBe('1 hr'); // 1.4833... rounds down to 1
  });
});
