/**
 * Pure mapping from the server's Progress Overview (#3522) to the Map's
 * Progress screen (#3528). The server computes every figure (D19); this module
 * names stages, places markers and words the rhythm without naming a phase
 * (D14) or ranking anything (ADR 0003).
 */
import type { ApiProgressOverview } from '@/api';
import type { ChartPoint, Dumbbell, RibbonBlock, RibbonMarker } from '@/components/charts';
import { formatHistoryValue } from '@/components/charts/HistoryPlot';
import { chart, STAGE_COLORS, STAGE_ORDER } from '@/design/tokens';
import { dayKeyToInstant } from '@/utils/dateUtils';

/** The rhythm has no shape to show before four weeks of days (D09). */
export const RHYTHM_MIN_DAYS = 28;
export const RHYTHM_EARLY_LINE = 'The rhythm view appears after four weeks.';
const PERCENT = 100;
const EARLY_MONTH_LAST_DAY = 10;
const MID_MONTH_LAST_DAY = 20;

const instant = (date: string) => dayKeyToInstant(date, 'UTC');
const format = (date: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(instant(date));

export const stageName = (stageNumber: number): string =>
  STAGE_ORDER[stageNumber - 1] ?? `Stage ${stageNumber}`;
export const stageColor = (stageNumber: number): string =>
  STAGE_COLORS[stageName(stageNumber)] ?? chart.dim;
export const percent = (rate: number): string => `${Math.round(rate * PERCENT)}%`;

/** D13: ten stage blocks sized by weeks, colour aligned to the shared adoption timelines. */
export const ribbonBlocks = (overview: ApiProgressOverview): RibbonBlock[] =>
  overview.arc.stages.map((stage) => ({
    label: `${stageName(stage.stage_number)} · ${stage.aspect}`,
    weeks: stage.weeks,
    color: stageColor(stage.stage_number),
  }));

/** Habit births as dots on the weeks they began; carryovers are listed apart. */
export const birthMarkers = (overview: ApiProgressOverview): RibbonMarker[] =>
  overview.arc.habit_births.flatMap((birth) =>
    birth.week === null || birth.is_carryover
      ? []
      : [{ week: birth.week, label: `${birth.name} began` }],
  );

export const carryovers = (overview: ApiProgressOverview): string[] =>
  overview.arc.habit_births.filter((birth) => birth.is_carryover).map((birth) => birth.name);

/** "week 23 · Yellow", or null when the arc has no known anchor. */
export function youAreHere(overview: ApiProgressOverview): string | null {
  const { current_week: week, current_stage: stage } = overview.arc;
  return week === null ? null : `Week ${week} · ${stageName(stage)}`;
}

export function arcSummary(overview: ApiProgressOverview): string {
  const here = youAreHere(overview);
  const births = birthMarkers(overview).length;
  return `The 36-week arc in ten stages.${here ? ` You are in ${here.toLowerCase()}.` : ''} ${births} ${births === 1 ? 'habit began' : 'habits began'} along it.`;
}

export const rhythmPoints = (overview: ApiProgressOverview): ChartPoint[] =>
  overview.rhythm.days.map((day) => ({
    label: format(day.date, { day: 'numeric', month: 'short', year: 'numeric' }),
    value: day.rate * PERCENT,
    stateLabel: `${day.window_met} of ${day.window_scheduled} kept`,
  }));

export const rhythmVisible = (overview: ApiProgressOverview): boolean =>
  overview.rhythm.days.length >= RHYTHM_MIN_DAYS;

/** The wave's latest figure, for the header row: `62%`. */
export function rhythmNow(overview: ApiProgressOverview): string | null {
  const last = overview.rhythm.days.at(-1);
  return last ? percent(last.rate) : null;
}

export const percentFigure = (value: number): string => `${Math.round(value)}%`;

const partOfMonth = (date: string): string => {
  const day = instant(date).getUTCDate();
  const part = day <= EARLY_MONTH_LAST_DAY ? 'early' : day <= MID_MONTH_LAST_DAY ? 'mid' : 'late';
  return `${part} ${format(date, { month: 'long' })}`;
};
const dayMonth = (date: string): string => format(date, { day: 'numeric', month: 'long' });

/**
 * The server's caption (#3525) whenever it sends observations, an empty list
 * meaning nothing to say; an older server's facts are worded here instead.
 */
export function rhythmCaption(overview: ApiProgressOverview): string | null {
  if (overview.observations !== undefined) return overview.observations[0] ?? null;
  const {
    fullest_week_ending: fullest,
    longest_rest: rest,
    rising_since: rising,
  } = overview.rhythm;
  const parts = [
    fullest ? `Your fullest week was ${partOfMonth(fullest)}.` : null,
    rest ? `You rested from ${dayMonth(rest.start)} to ${dayMonth(rest.end)}.` : null,
    rising ? `You have been rising since ${dayMonth(rising)}.` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function rhythmSummary(overview: ApiProgressOverview): string {
  const last = overview.rhythm.days.at(-1);
  const now = last
    ? ` Now ${percent(last.rate)}: ${last.window_met} of ${last.window_scheduled} kept.`
    : '';
  return `Your rhythm over ${overview.rhythm.days.length} days, each point the share of scheduled habits and practice kept in the seven days up to it.${now}`;
}

/** D15: per stage, the previous cycle to this one; absent before a second pass. */
export const cycleRows = (overview: ApiProgressOverview): Dumbbell[] =>
  overview.cycles.flatMap((stage) => {
    const latest = stage.rates.at(-1);
    if (!latest) return [];
    const earlier = stage.rates.at(-2);
    return [{ label: stageName(stage.stage_number), from: earlier?.rate ?? null, to: latest.rate }];
  });

export function cycleLabels(overview: ApiProgressOverview): { from: string; to: string } {
  const cycle = overview.arc.cycle_number;
  return { from: `Cycle ${Math.max(1, cycle - 1)}`, to: `Cycle ${cycle}` };
}

export const CYCLE_CAPTION = 'Either direction is part of the shape.';

/** What the energy columns show, said once, on the chart's header row. */
export const ENERGY_MEASURE = 'Energy returned minus effort spent, by week';

export function energySummary(overview: ApiProgressOverview): string {
  const weeks = overview.energy.weeks;
  const latest = weeks.at(-1);
  return `Net energy for ${weeks.length} weeks: energy returned minus effort spent on logged habits.${latest ? ` The latest week is ${latest.net}.` : ''}`;
}

export const energyPoints = (overview: ApiProgressOverview): ChartPoint[] =>
  overview.energy.weeks.map((week) => ({
    label: `Week of ${format(week.week_start, { day: 'numeric', month: 'short', year: 'numeric' })}`,
    value: week.net,
  }));

export const energyNow = (overview: ApiProgressOverview): string | null => {
  const latest = overview.energy.weeks.at(-1);
  return latest ? String(latest.net) : null;
};

interface ServedHistory {
  unit: string;
  days: { date: string; units: number; average: number }[];
}

export interface HabitHistory {
  unit: string;
  /** Spoken after a figure: `sets a day`. */
  perDay: string;
  /** The latest 7-day average, with its unit. */
  now: string;
  points: ChartPoint[];
}

const shortDate = (date: string): string =>
  format(date, { day: 'numeric', month: 'short', year: 'numeric' });

function unitHistory(history: ServedHistory): HabitHistory {
  const unit = history.unit || 'units';
  const perDay = `${unit} a day`;
  const last = history.days.at(-1);
  return {
    unit: history.unit,
    perDay,
    now: `${formatHistoryValue(last?.average ?? 0)} ${perDay}`,
    points: history.days.map((day) => ({
      label: shortDate(day.date),
      value: day.average,
      stateLabel: `${formatHistoryValue(day.units)} logged that day`,
    })),
  };
}

/**
 * Each habit's logged measures as 7-day averages, in its adoption colour. A
 * habit with nothing logged yet has no line to draw and is left out.
 */
export const habitHistories = (overview: ApiProgressOverview) =>
  overview.arc.habit_births.flatMap((birth) => {
    const histories = (birth.unit_histories ?? []).map(unitHistory);
    return histories.length === 0
      ? []
      : [
          {
            id: birth.habit_id,
            name: birth.name,
            carryover: birth.is_carryover,
            color: birth.stage_number === null ? chart.dim : stageColor(birth.stage_number),
            histories,
          },
        ];
  });

/** The one date range every habit line shares, said once for the section. */
export function habitRange(overview: ApiProgressOverview): string | null {
  const days = overview.arc.habit_births.find((birth) => birth.unit_histories?.length)
    ?.unit_histories?.[0]?.days;
  const first = days?.[0];
  const last = days?.at(-1);
  if (!first || !last) return null;
  const range = (date: string) => format(date, { day: 'numeric', month: 'short' });
  return `7-day averages, ${range(first.date)} to ${range(last.date)}.`;
}
