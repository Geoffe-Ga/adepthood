import { describe, expect, it } from '@jest/globals';

import {
  continuityLines,
  ledgerCsv,
  ledgerFilename,
  ledgerJson,
  logDays,
  pageLogDays,
  rateLines,
  stageStrips,
  tierTotalLines,
  timeOfDayRows,
  untimedLine,
  weekdayLines,
  weeklyTierRows,
} from '../ledgerPresentation';

import { habitStoryFixture, storyDays } from '@/features/Habits/testSupport/habitStoryFixture';

const at = () => '18:40';

describe('ledgerPresentation', () => {
  it('words every continuity figure with its unit', () => {
    expect(continuityLines(habitStoryFixture())).toEqual([
      { label: 'Current run', value: '7 days' },
      { label: 'Longest run', value: '15 days' },
      { label: 'Returns after a rest', value: '9' },
      { label: 'Days with', value: '45' },
    ]);
  });

  it('names a single unit in the singular', () => {
    const story = habitStoryFixture();
    const lines = continuityLines({
      ...story,
      continuity: { ...story.continuity, current_run: 1, unit: 'weeks' },
    });
    expect(lines[0]).toEqual({ label: 'Current run', value: '1 week' });
    expect(lines[3]?.label).toBe('Weeks with');
  });

  it('shows each window with met, scheduled and the percentage', () => {
    expect(rateLines(habitStoryFixture())).toEqual([
      { label: 'Last 7 days', value: '7 of 7 scheduled days (100%)' },
      { label: 'Last 21 days', value: '16 of 21 scheduled days (76%)' },
      { label: 'Last 30 days', value: '22 of 30 scheduled days (73%)' },
      { label: 'All time', value: '45 of 51 scheduled days (88%)' },
    ]);
  });

  it('omits a percentage when nothing was scheduled', () => {
    const story = habitStoryFixture();
    const lines = rateLines({
      ...story,
      rates: { ...story.rates, last_7: { met: 0, scheduled: 0 } },
    });
    expect(lines[0]?.value).toBe('0 of 0 scheduled days');
  });

  it('labels tiers as limits for a subtractive habit', () => {
    expect(tierTotalLines(habitStoryFixture()).map((row) => row.label)).toEqual([
      'Low',
      'Clear',
      'Stretch',
      'Under Low',
      'Quiet',
    ]);
    expect(
      tierTotalLines(habitStoryFixture({ polarity: 'subtractive' })).map((row) => row.label),
    ).toEqual(['Within Low limit', 'Within Clear limit', 'Within Stretch limit', 'Over', 'Quiet']);
    expect(tierTotalLines(habitStoryFixture())[1]?.value).toBe('26 days');
  });

  it('tabulates the weekly stack one week per row', () => {
    expect(weeklyTierRows(habitStoryFixture())).toEqual([
      { label: 'Week of Tue, Oct 13, 2026', values: [1, 4, 1, 0, 1] },
      { label: 'Week of Tue, Oct 20, 2026', values: [2, 3, 2, 0, 0] },
    ]);
  });

  it('tabulates weekdays and weekday by time of day, with time not recorded', () => {
    expect(weekdayLines(habitStoryFixture())[3]).toEqual({ label: 'Thu', value: '12 pages' });
    const rows = timeOfDayRows(habitStoryFixture());
    expect(rows[0]).toEqual({ label: 'Mon', values: ['6', '2', '2', '0'] });
    expect(rows).toHaveLength(7);
    expect(untimedLine(habitStoryFixture())).toEqual({
      label: 'Time not recorded',
      value: '12 pages',
    });
  });

  it('draws one strip per stage the history touches, named and coloured', () => {
    const strips = stageStrips(habitStoryFixture());
    expect(strips.map((strip) => [strip.name, strip.cells.length])).toEqual([
      ['Beige', 21],
      ['Purple', 21],
      ['Red', 9],
    ]);
    expect(strips[0]?.color).toMatch(/^#/);
  });

  it('groups logs by day, newest first, each day with its total', () => {
    const days = logDays(habitStoryFixture(), at);
    expect(days.map((day) => day.heading)).toEqual([
      'Tue, Oct 27, 2026 · 2 pages',
      'Mon, Oct 26, 2026 · 2 pages',
    ]);
    expect(days[0]?.rows).toEqual([
      {
        key: '2026-10-27T14:05:00Z-0',
        time: '18:40',
        amount: '+2 pages',
        source: 'with the timer',
      },
    ]);
    expect(days[1]?.rows[0]?.amount).toBe('−1 pages');
  });

  it('lists a day of untimed units as time not recorded', () => {
    const story = habitStoryFixture({
      logs: [],
      days: storyDays('2026-10-23', 2, [{ unknown_time_units: 48, units: 48 }]),
    });
    expect(logDays(story, at)).toEqual([
      {
        date: '2026-10-23',
        heading: 'Fri, Oct 23, 2026 · 48 pages',
        rows: [],
        untimed: '48 pages',
      },
    ]);
  });

  it('pages logs by row and says when more remain', () => {
    const days = logDays(habitStoryFixture(), at);
    expect(pageLogDays(days, 1)).toEqual({ days: [days[0]], more: true });
    expect(pageLogDays(days, 2)).toEqual({ days, more: false });
    const untimed = [{ ...days[0]!, untimed: '3 pages' }];
    expect(pageLogDays(untimed, 1)).toEqual({
      days: [{ ...days[0], untimed: null }],
      more: true,
    });
  });

  it('exports the days, logs and weekly tiers as three CSV tables', () => {
    const csv = ledgerCsv(habitStoryFixture({ days: storyDays('2026-10-26', 1) }));
    expect(csv.split('\n\n').map((table) => table.split('\n').slice(0, 3))).toEqual([
      [
        '# days',
        'date,units,tier,logged,scheduled,met,untimed_units',
        '2026-10-26,2,clear,true,true,true,0',
      ],
      [
        '# logs',
        'timestamp,local_day,delta_units,via_timer,source',
        '2026-10-27T14:05:00Z,2026-10-27,2,true,manual',
      ],
      ['# weekly_tiers', 'week_start,low,clear,stretch,under,quiet', '2026-10-13,1,4,1,0,1'],
    ]);
  });

  it('quotes a CSV cell that holds a comma or a quote', () => {
    const story = habitStoryFixture({
      logs: [
        {
          timestamp: '2026-10-27T14:05:00Z',
          local_day: '2026-10-27',
          delta_units: 1,
          via_timer: false,
          source: 'a "b", c',
        },
      ],
    });
    expect(ledgerCsv(story)).toContain('2026-10-27T14:05:00Z,2026-10-27,1,false,"a ""b"", c"');
  });

  it('exports the same series as JSON with the habit beside them', () => {
    const parsed = JSON.parse(ledgerJson(habitStoryFixture(), 'Morning pages')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed)).toEqual([
      'habit',
      'unit',
      'cadence',
      'polarity',
      'today',
      'days',
      'logs',
      'weekly_tiers',
    ]);
    expect(parsed.habit).toBe('Morning pages');
  });

  it('names the file after the habit and the day', () => {
    expect(ledgerFilename('Morning pages!', '2026-10-27', 'csv')).toBe(
      'adepthood-morning-pages-2026-10-27.csv',
    );
    expect(ledgerFilename('🚶', '2026-10-27', 'json')).toBe('adepthood-habit-2026-10-27.json');
  });
});
