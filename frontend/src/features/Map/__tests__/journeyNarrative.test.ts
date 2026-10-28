/* eslint-env jest */
/* global describe, it, expect */
import {
  MAP_LEAD,
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
      cadence_unit: 'days',
      total_completions: 45,
    },
  ],
};

const WEEKLY: StageHistoryResponse = {
  stage_number: 1,
  practices: HISTORY.practices,
  habits: [
    {
      name: 'Long run',
      icon: '🏃',
      goals_achieved: { low: true },
      best_streak: 2,
      cadence_unit: 'weeks',
      total_completions: 4,
    },
  ],
};

const EMPTY: StageHistoryResponse = { stage_number: 1, practices: [], habits: [] };

describe('journeyRead', () => {
  it('renders "Stage N of 10 · Week W"', () => {
    expect(journeyRead(5, 12, 10)).toBe('Stage 5 of 10 · Week 12');
  });
});

describe('MAP_LEAD', () => {
  it('describes a wheel of capacities without altitude or rank language', () => {
    expect(MAP_LEAD).toContain('wheel, not a ladder');
    expect(MAP_LEAD).toContain('ten stages revisit different capacities');
    expect(MAP_LEAD).toContain('never ranking');
    expect(MAP_LEAD).not.toMatch(/full|thin/i);
    expect(MAP_LEAD).not.toMatch(/higher|lower|above|below|climb|ascend/i);
  });
});

describe('unlockTimeline', () => {
  it('pluralises day counts', () => {
    expect(unlockTimeline(3)).toBe('Opens in 3 days');
    expect(unlockTimeline(1)).toBe('Opens in 1 day');
  });

  it('treats zero / negative as unlocking now', () => {
    expect(unlockTimeline(0)).toBe('Opening now');
    expect(unlockTimeline(-2)).toBe('Opening now');
  });

  it('falls back to the condition when no anchor is set', () => {
    expect(unlockTimeline(null)).toBe('Opens with the course');
  });
});

describe('progressionSentence', () => {
  it('reads as one sentence with sessions and a run, never a streak', () => {
    const sentence = progressionSentence(HISTORY);
    expect(sentence).toBe('You logged 15 sessions across 2 practices and kept a run of 14 days.');
    expect(sentence).not.toMatch(/streak/i);
  });

  it("counts a weekly habit's run in weeks (#3528)", () => {
    expect(progressionSentence(WEEKLY)).toBe(
      'You logged 15 sessions across 2 practices and kept a run of 2 weeks.',
    );
  });

  it('treats a history from before cadence_unit as days', () => {
    const legacy = structuredClone(WEEKLY);
    delete (legacy.habits[0] as { cadence_unit?: string }).cadence_unit;
    legacy.habits[0]!.best_streak = 1;
    expect(progressionSentence(legacy)).toContain('kept a run of 1 day.');
  });

  it('falls back to a beginning-of-story line when empty', () => {
    expect(progressionSentence(EMPTY)).toContain('just beginning');
  });
});

describe('rankedStats', () => {
  it('keeps a fixed order, never sorting figures by size (ADR 0003)', () => {
    const stats = rankedStats(HISTORY);
    // 15 sessions, 210 min → 4 hours, a 14-day run: the order is fixed, not by size.
    expect(stats).toEqual([
      { key: 'sessions', label: 'Sessions', value: 15 },
      { key: 'minutes', label: 'Hours', value: 4 },
      { key: 'run', label: 'Longest run (days)', value: 14 },
    ]);
    expect(rankedStats(WEEKLY).at(-1)).toEqual({
      key: 'run',
      label: 'Longest run (weeks)',
      value: 2,
    });
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

  it('promotes durations that round up to 60 minutes into the hours branch', () => {
    expect(formatMinutes(59.5)).toBe('1 hr');
    expect(formatMinutes(59.6)).toBe('1 hr');
    expect(formatMinutes(59.99)).toBe('1 hr');
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
