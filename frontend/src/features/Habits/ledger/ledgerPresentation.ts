/**
 * The Habit Ledger's complete numeric record (#3529), mapped from the server's
 * Habit Story (#3524). Every figure keeps its window and denominator; nothing
 * is recomputed here beyond grouping and wording (D19).
 */
import type { ApiHabitStory } from '@/api';
import type { ChartTableRow, HeatCell } from '@/components/charts';
import { STAGE_COLORS, STAGE_ORDER, chart } from '@/design/tokens';
import {
  amount,
  countIn,
  dayCell,
  formatStoryLongDate,
  MINUS,
  SINGULAR,
  sourceWords,
  TIME_OF_DAY_LABELS,
  WEEKDAY_NAMES,
  WITH_LABEL,
} from '@/features/Habits/story/habitStoryPresentation';

type StoryDay = ApiHabitStory['days'][number];

/** Logs shown per page before "Show more" (the server already caps the list). */
export const LEDGER_LOG_PAGE = 50;
const PERCENT = 100;
const WINDOWS = [
  ['last_7', 7],
  ['last_21', 21],
  ['last_30', 30],
] as const;

export const signed = (value: number, unit: string): string =>
  `${value > 0 ? '+' : value < 0 ? MINUS : ''}${amount(Math.abs(value))} ${unit}`;

export interface LedgerLine {
  label: string;
  value: string;
}

export function continuityLines(story: ApiHabitStory): LedgerLine[] {
  const { current_run, longest_run, returns, days_with, unit } = story.continuity;
  return [
    { label: 'Current run', value: countIn(current_run, unit) },
    { label: 'Longest run', value: countIn(longest_run, unit) },
    { label: 'Returns after a rest', value: String(returns) },
    { label: WITH_LABEL[unit], value: String(days_with) },
  ];
}

const share = (met: number, scheduled: number): string =>
  scheduled > 0 ? ` (${Math.round((met / scheduled) * PERCENT)}%)` : '';

/** "Last 21 days: 16 of 21 scheduled days (76%)", each window with its denominator. */
export function rateLines(story: ApiHabitStory): LedgerLine[] {
  const unit = story.rates.unit;
  const line = (label: string, rate: { met: number; scheduled: number }): LedgerLine => ({
    label,
    value: `${rate.met} of ${rate.scheduled} scheduled ${rate.scheduled === 1 ? SINGULAR[unit] : unit}${share(rate.met, rate.scheduled)}`,
  });
  return [
    ...WINDOWS.map(([key, days]) => line(`Last ${days} days`, story.rates[key])),
    line('All time', story.rates.all_time),
  ];
}

/** Tier labels; a subtractive habit's tiers are limits it stayed within. */
export function tierLabels(story: ApiHabitStory) {
  return story.polarity === 'subtractive'
    ? {
        low: 'Within Low limit',
        clear: 'Within Clear limit',
        stretch: 'Within Stretch limit',
        under: 'Over',
        quiet: 'Quiet',
      }
    : {
        low: 'Low',
        clear: 'Clear',
        stretch: 'Stretch',
        under: 'Under Low',
        quiet: 'Quiet',
      };
}

export function tierTotalLines(story: ApiHabitStory): LedgerLine[] {
  const labels = tierLabels(story);
  const totals = story.tiers.totals;
  return (['low', 'clear', 'stretch', 'under', 'quiet'] as const).map((key) => ({
    label: labels[key],
    value: countIn(totals[key], 'days'),
  }));
}

export function weeklyTierRows(story: ApiHabitStory): ChartTableRow[] {
  return story.tiers.weekly.map((week) => ({
    label: `Week of ${formatStoryLongDate(week.week_start)}`,
    values: [week.low, week.clear, week.stretch, week.under, week.quiet],
  }));
}

export const weekdayLines = (story: ApiHabitStory): LedgerLine[] =>
  WEEKDAY_NAMES.map((weekday, index) => ({
    label: weekday,
    value: `${amount(story.patterns.weekday_units[index] ?? 0)} ${story.unit}`,
  }));

export const timeOfDayRows = (story: ApiHabitStory): ChartTableRow[] =>
  WEEKDAY_NAMES.map((weekday, index) => ({
    label: weekday,
    values: TIME_OF_DAY_LABELS.map((_time, column) =>
      amount(story.patterns.weekday_by_time_of_day[index]?.[column] ?? 0),
    ),
  }));

/** Units logged before times were recorded, which no time-of-day column can hold. */
export const untimedLine = (story: ApiHabitStory): LedgerLine => ({
  label: 'Time not recorded',
  value: `${amount(story.patterns.unknown_time_units)} ${story.unit}`,
});

export interface StageStrip {
  stageNumber: number;
  name: string;
  color: string;
  cells: HeatCell[];
}

/** "By stage": one strip of day cells per program stage the history touches. */
export const stageStrips = (story: ApiHabitStory): StageStrip[] =>
  story.stages.map((stage) => {
    const name = STAGE_ORDER[stage.stage_number - 1] ?? `Stage ${stage.stage_number}`;
    return {
      stageNumber: stage.stage_number,
      name,
      color: STAGE_COLORS[name] ?? chart.dim,
      cells: story.days
        .filter((day) => day.date >= stage.opens_on && day.date <= stage.closes_on)
        .map((day) => dayCell(day, story.unit)),
    };
  });

export interface LedgerLogRow {
  key: string;
  time: string;
  amount: string;
  source: string;
}

export interface LedgerLogDay {
  date: string;
  heading: string;
  rows: LedgerLogRow[];
  /** Units on this day logged before times were recorded, if any. */
  untimed: string | null;
}

/** Days with a log or with untimed units, newest first, each with its own total. */
export function logDays(
  story: ApiHabitStory,
  formatTime: (_timestamp: string) => string,
): LedgerLogDay[] {
  const byDay = new Map<string, LedgerLogRow[]>();
  story.logs.forEach((log, index) => {
    const rows = byDay.get(log.local_day) ?? [];
    rows.push({
      key: `${log.timestamp}-${index}`,
      time: formatTime(log.timestamp),
      amount: signed(log.delta_units, story.unit),
      source: sourceWords(log.source, log.via_timer),
    });
    byDay.set(log.local_day, rows);
  });
  const recorded = (day: StoryDay) => byDay.has(day.date) || day.unknown_time_units !== 0;
  return [...story.days]
    .reverse()
    .filter(recorded)
    .map((day) => ({
      date: day.date,
      heading: `${formatStoryLongDate(day.date)} · ${amount(day.units)} ${story.unit}`,
      rows: byDay.get(day.date) ?? [],
      untimed:
        day.unknown_time_units === 0 ? null : `${amount(day.unknown_time_units)} ${story.unit}`,
    }));
}

const csvCell = (value: string | number | boolean | null): string => {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csvTable = (title: string, header: string[], rows: (string | number | boolean | null)[][]) =>
  [`# ${title}`, header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');

/** The days, logs and weekly tier series as three CSV tables in one file. */
export function ledgerCsv(story: ApiHabitStory): string {
  return [
    csvTable(
      'days',
      ['date', 'units', 'tier', 'logged', 'scheduled', 'met', 'untimed_units'],
      story.days.map((day) => [
        day.date,
        day.units,
        day.tier,
        day.logged,
        day.scheduled,
        day.met,
        day.unknown_time_units,
      ]),
    ),
    csvTable(
      'logs',
      ['timestamp', 'local_day', 'delta_units', 'via_timer', 'source'],
      story.logs.map((log) => [
        log.timestamp,
        log.local_day,
        log.delta_units,
        log.via_timer,
        log.source,
      ]),
    ),
    csvTable(
      'weekly_tiers',
      ['week_start', 'low', 'clear', 'stretch', 'under', 'quiet'],
      story.tiers.weekly.map((week) => [
        week.week_start,
        week.low,
        week.clear,
        week.stretch,
        week.under,
        week.quiet,
      ]),
    ),
  ].join('\n\n');
}

/** The same series as one JSON document, with the habit's unit and calendar beside them. */
export const ledgerJson = (story: ApiHabitStory, name: string): string =>
  JSON.stringify(
    {
      habit: name,
      unit: story.unit,
      cadence: story.cadence,
      polarity: story.polarity,
      today: story.today,
      days: story.days,
      logs: story.logs,
      weekly_tiers: story.tiers.weekly,
    },
    null,
    2,
  );

/** A file name a person can recognise beside last month's copy. */
export const ledgerFilename = (name: string, today: string, extension: 'csv' | 'json'): string =>
  `adepthood-${
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '') || 'habit'
  }-${today}.${extension}`;

const rowCount = (day: LedgerLogDay): number => day.rows.length + (day.untimed === null ? 0 : 1);

/** The first ``limit`` log rows, kept under their days, and whether more remain. */
export function pageLogDays(
  days: LedgerLogDay[],
  limit: number,
): { days: LedgerLogDay[]; more: boolean } {
  const paged: LedgerLogDay[] = [];
  let left = limit;
  for (const day of days) {
    if (left <= 0) break;
    const rows = day.rows.slice(0, left);
    const untimed = rows.length < left ? day.untimed : null;
    paged.push({ ...day, rows, untimed });
    left -= rowCount({ ...day, rows, untimed });
  }
  const total = days.reduce((sum, day) => sum + rowCount(day), 0);
  return { days: paged, more: total > limit };
}
