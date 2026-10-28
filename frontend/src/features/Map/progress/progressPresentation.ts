/**
 * Pure mapping from the server's Progress Overview (#3522) to the Map's
 * Progress screen (#3528). The server computes every figure (D19); this module
 * names stages, places markers and words the rhythm without naming a phase
 * (D14) or ranking anything (ADR 0003).
 */
import type { ApiProgressOverview } from '@/api';
import type {
  ChartColumn,
  ChartPoint,
  Dumbbell,
  RibbonBlock,
  RibbonMarker,
  WaveSwatch,
  WaveTick,
} from '@/components/charts';
import { accent, chart, STAGE_COLORS, STAGE_ORDER } from '@/design/tokens';
import { dayKeyToInstant } from '@/utils/dateUtils';

/** The rhythm has no shape to show before four weeks of days (D09). */
export const RHYTHM_MIN_DAYS = 28;
export const RHYTHM_EARLY_LINE = 'The rhythm view appears after four weeks.';
/** Energy columns: the share above zero and the share below it. */
export const ENERGY_SERIES = ['Above zero', 'Below zero'] as const;
export const ENERGY_COLORS = [accent.primary, chart.dim] as const;

const PERCENT = 100;
const EARLY_MONTH_LAST_DAY = 10;
const MID_MONTH_LAST_DAY = 20;

const instant = (date: string) => dayKeyToInstant(date, 'UTC');
const format = (date: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(instant(date));

export const stageName = (stageNumber: number): string =>
  STAGE_ORDER[stageNumber - 1] ?? `Stage ${stageNumber}`;
const stageColor = (stageNumber: number): string =>
  STAGE_COLORS[stageName(stageNumber)] ?? chart.dim;
export const percent = (rate: number): string => `${Math.round(rate * PERCENT)}%`;

/** D13: ten stage blocks sized by weeks, colour only as a labelled swatch. */
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
      : [{ week: birth.week, label: `${birth.icon} ${birth.name} · week ${birth.week}` }],
  );

export const carryovers = (overview: ApiProgressOverview): string[] =>
  overview.arc.habit_births
    .filter((birth) => birth.is_carryover)
    .map((birth) => `${birth.icon} ${birth.name}`);

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
    label: format(day.date, { day: 'numeric', month: 'short' }),
    value: Math.round(day.rate * PERCENT),
    stateLabel: `${day.daily_met} of ${day.daily_scheduled} that day`,
  }));

/** A tick at the first day of each month the series spans. */
export const rhythmTicks = (overview: ApiProgressOverview): WaveTick[] =>
  overview.rhythm.days.flatMap((day, index) =>
    day.date.endsWith('-01') || index === 0
      ? [{ index, label: format(day.date, { month: 'short' }) }]
      : [],
  );

/** A swatch where a stage opens inside the series, labelled with its name. */
export function rhythmSwatches(overview: ApiProgressOverview): WaveSwatch[] {
  const indexOf = new Map(overview.rhythm.days.map((day, index) => [day.date, index]));
  return overview.arc.stages.flatMap((stage) => {
    const index = stage.opens_on === null ? undefined : indexOf.get(stage.opens_on);
    return index === undefined
      ? []
      : [{ index, label: stageName(stage.stage_number), color: stageColor(stage.stage_number) }];
  });
}

export const rhythmVisible = (overview: ApiProgressOverview): boolean =>
  overview.rhythm.days.length >= RHYTHM_MIN_DAYS;

export function rhythmEnd(overview: ApiProgressOverview): string | null {
  const last = overview.rhythm.days.at(-1);
  return last ? `Now ${percent(last.rate)} over the last ${last.window_days} days` : null;
}

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
    fullest_fortnight_ending: fullest,
    longest_rest: rest,
    rising_since: rising,
  } = overview.rhythm;
  const parts = [
    fullest ? `Your fullest fortnight was ${partOfMonth(fullest)}.` : null,
    rest ? `You rested from ${dayMonth(rest.start)} to ${dayMonth(rest.end)}.` : null,
    rising ? `You have been rising since ${dayMonth(rising)}.` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function rhythmSummary(overview: ApiProgressOverview): string {
  const end = rhythmEnd(overview);
  return `Your rhythm over ${overview.rhythm.days.length} days, each point the share of the last fourteen days kept.${end ? ` ${end}.` : ''}`;
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

export function cycleCaption(overview: ApiProgressOverview): string {
  const { from, to } = cycleLabels(overview);
  return `Each line runs from ${from.toLowerCase()} to ${to.toLowerCase()}: the share of scheduled days kept in that stage. Either direction is part of the shape.`;
}

/** D16: weekly net energy, the part above zero in the accent and below it de-emphasised. */
export const energyColumns = (overview: ApiProgressOverview): ChartColumn[] =>
  overview.energy.weeks.map((week) => ({
    label: `Week of ${format(week.week_start, { day: 'numeric', month: 'short' })}`,
    segments: [Math.max(week.net, 0), Math.min(week.net, 0)],
  }));

export function energySummary(overview: ApiProgressOverview): string {
  const weeks = overview.energy.weeks;
  const latest = weeks.at(-1);
  return `Net energy per week for ${weeks.length} weeks, ${overview.energy.formula}.${latest ? ` The latest week is ${latest.net}.` : ''}`;
}
