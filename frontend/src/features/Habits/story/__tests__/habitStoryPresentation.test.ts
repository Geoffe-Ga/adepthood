import { describe, expect, it } from '@jest/globals';

import {
  datedMilestones,
  earlyDaysLine,
  glanceTiles,
  gridRange,
  heatGrid,
  patternGrid,
  patternSummary,
  rateLine,
  signedDelta,
  storyDepth,
  STORY_CHARTS_MIN,
  STORY_PATTERNS_MIN,
  STORY_TIER_STACK_MIN,
  tierColumns,
  tierTiles,
  unknownTimeNote,
} from '../habitStoryPresentation';

import { habitStoryFixture, storyDays } from '@/features/Habits/testSupport/habitStoryFixture';

const withDaysWith = (days_with: number) => {
  const story = habitStoryFixture();
  return habitStoryFixture({ continuity: { ...story.continuity, days_with } });
};

describe('Glance', () => {
  it('names the four figures in the habit cadence unit, with the denominator on Days with', () => {
    expect(glanceTiles(habitStoryFixture())).toEqual([
      { key: 'current', label: 'Current run', value: '7 days' },
      { key: 'longest', label: 'Longest run', value: '15 days' },
      { key: 'returns', label: 'Returns', value: '9' },
      { key: 'with', label: 'Days with', value: '45', caption: 'of 51 scheduled' },
    ]);
  });

  it('counts a weekly habit in weeks, singular where it is one', () => {
    const story = habitStoryFixture({
      cadence: 'week',
      continuity: { current_run: 1, longest_run: 3, returns: 0, days_with: 4, unit: 'weeks' },
    });
    const tiles = glanceTiles(story);
    expect(tiles[0]?.value).toBe('1 week');
    expect(tiles[1]?.value).toBe('3 weeks');
    expect(tiles[3]?.label).toBe('Weeks with');
  });
});

describe('rates', () => {
  it('shows the stage window and all time with their scheduled denominators', () => {
    expect(rateLine(habitStoryFixture())).toBe(
      '16 of 21 scheduled days in the last 21 days · all time 45 of 51',
    );
  });

  it('names periods for a period cadence', () => {
    const story = habitStoryFixture();
    expect(
      rateLine(
        habitStoryFixture({
          rates: {
            ...story.rates,
            last_21: { met: 2, scheduled: 3 },
            all_time: { met: 5, scheduled: 8 },
            unit: 'weeks',
          },
        }),
      ),
    ).toBe('2 of 3 scheduled weeks in the last 21 days · all time 5 of 8');
  });
});

describe('early days (D09)', () => {
  it.each([
    [STORY_CHARTS_MIN - 1, { charts: false, tierStack: false, patterns: false }],
    [STORY_CHARTS_MIN, { charts: true, tierStack: false, patterns: false }],
    [STORY_TIER_STACK_MIN, { charts: true, tierStack: true, patterns: false }],
    [STORY_PATTERNS_MIN, { charts: true, tierStack: true, patterns: true }],
  ])('at %i days with, draws %o', (count, depth) => {
    expect(storyDepth(withDaysWith(count))).toEqual(depth);
  });

  it('prefers the server observation and falls back to a plain fact', () => {
    expect(earlyDaysLine(habitStoryFixture({ observations: ['Three mornings.'] }), 'Pages')).toBe(
      'Three mornings.',
    );
    expect(earlyDaysLine(withDaysWith(3), 'Pages')).toBe(
      '3 days with Pages so far. The shape appears here after 7.',
    );
    expect(earlyDaysLine(withDaysWith(0), 'Pages')).toBe(
      'The shape of Pages appears here after its first 7 days.',
    );
  });
});

describe('heat grid', () => {
  it('lays days into Monday-start columns with stage markers', () => {
    const grid = heatGrid(habitStoryFixture());
    expect(grid.weeks).toHaveLength(8);
    expect(grid.weeks[0]).toHaveLength(7);
    expect(grid.weekStarts[0]).toBe('2026-09-07');
    expect(grid.markers.map((marker) => [marker.label, marker.columnIndex])).toEqual([
      ['Beige', 0],
      ['Purple', 3],
      ['Red', 6],
    ]);
    expect(grid.columnLabels).toEqual(['Sep 7', 'Oct 26']);
    expect(gridRange(grid)).toBe(
      'A column per week, from the week of Sep 7 to the week of Oct 26.',
    );
  });

  it('pads before a mid-week start and marks a logged-under day hollow', () => {
    const story = habitStoryFixture({
      start_date: '2026-10-21',
      days: storyDays('2026-10-21', 3, [
        {},
        { tier: null, met: false, units: 1 },
        { tier: null, met: false, logged: false, units: 0 },
      ]),
      stages: [],
    });
    const [week] = heatGrid(story).weeks;
    expect(week?.slice(0, 2).map((cell) => cell.level)).toEqual([0, 0]);
    expect(week?.[0]?.label).toBe('Mon, Oct 19, 2026 · before this record');
    expect(week?.[2]).toEqual({
      label: 'Wed, Oct 21, 2026 · Clear · 2 pages',
      level: 2,
      hollow: false,
    });
    expect(week?.[3]).toEqual({
      label: 'Thu, Oct 22, 2026 · Logged, under Low · 1 pages',
      level: 0,
      hollow: true,
    });
    expect(week?.[4]?.label).toBe('Fri, Oct 23, 2026 · Quiet');
  });

  it('draws nothing for an empty series', () => {
    expect(heatGrid(habitStoryFixture({ days: [], stages: [] }))).toEqual({
      weeks: [],
      weekStarts: [],
      markers: [],
      columnLabels: [],
    });
  });
});

describe('tiers and patterns', () => {
  it('pairs each tier total with its thirty-day change', () => {
    expect(tierTiles(habitStoryFixture())).toEqual([
      { key: 'low', label: 'Low days', value: 9, delta: '−2' },
      { key: 'clear', label: 'Clear days', value: 26, delta: '+9' },
      { key: 'stretch', label: 'Stretch days', value: 10, delta: '±0' },
    ]);
    expect(signedDelta(3)).toBe('+3');
  });

  it('stacks weekly tier days with quiet days beside, dimming none', () => {
    expect(tierColumns(habitStoryFixture())).toEqual([
      { label: 'Week of Oct 13', segments: [1, 4, 1], quiet: 1 },
      { label: 'Week of Oct 20', segments: [2, 3, 2], quiet: 0 },
    ]);
  });

  it('gives each time of day a column of seven weekdays, scaled to the busiest cell', () => {
    const grid = patternGrid(habitStoryFixture());
    expect(grid).toHaveLength(4);
    expect(grid[0]).toHaveLength(7);
    expect(grid[0]?.[3]).toEqual({ label: 'Thu · Dawn · 8 pages', level: 3 });
    expect(grid[3]?.[0]?.level).toBe(0);
    expect(patternSummary(habitStoryFixture())).toContain('Most often on Thu Dawn.');
  });

  it('notes when times are only known for recent logs', () => {
    expect(unknownTimeNote(habitStoryFixture())).toBe('Times are known for logs since Oct 1.');
    const story = habitStoryFixture();
    expect(
      unknownTimeNote(
        habitStoryFixture({ patterns: { ...story.patterns, unknown_time_units: 0 } }),
      ),
    ).toBeNull();
    expect(
      unknownTimeNote(
        habitStoryFixture({ patterns: { ...story.patterns, time_of_day_available_since: null } }),
      ),
    ).toBe('Times are kept for logs from the next check-in on.');
  });
});

describe('milestones and logs', () => {
  it('dates the milestones it can word and leaves unknown kinds out', () => {
    const story = habitStoryFixture({
      milestones: [
        { kind: 'return', reached_on: '2026-08-22', value: 12 },
        { kind: 'mystery', reached_on: '2026-08-23', value: 1 },
        { kind: 'first_stretch', reached_on: '2026-09-01', value: 1 },
        { kind: 'days_with', reached_on: '2026-10-01', value: 21 },
        { kind: 'stage_complete', reached_on: '2026-10-05', value: 2 },
        { kind: 'stage_complete', reached_on: '2026-10-06', value: 99 },
      ],
    });
    expect(datedMilestones(story)).toEqual([
      { date: 'Aug 22', text: 'Back after 12 days. The record kept your place.' },
      { date: 'Sep 1', text: 'A first Stretch day' },
      { date: 'Oct 1', text: '21 days with this habit' },
      { date: 'Oct 5', text: 'Kept through Purple' },
    ]);
  });
});
