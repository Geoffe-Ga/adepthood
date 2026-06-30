/* eslint-env jest */
/* global describe, it, expect */
import { journeyRead, progressionSentence, rankedStats, unlockTimeline } from '../journeyNarrative';

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
