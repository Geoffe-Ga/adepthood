/**
 * Pure mapping from the server's Progress Overview (#3522) to the Map's
 * Progress screen (#3528). The server computes every figure (D19); this module
 * names stages, places markers and words the rhythm without naming a phase
 * (D14) or ranking anything (ADR 0003).
 */
import type { ApiProgressOverview } from '@/api';
import type { ChartPoint, Dumbbell, RibbonBlock, RibbonMarker } from '@/components/charts';
import { formatHistoryValue } from '@/components/charts/HistoryPlot';
import { chart, STAGE_COLORS } from '@/design/tokens';
import { storedStageColorName } from '@/store/stageColorName';
import { addDaysInTZ, dayKeyToInstant } from '@/utils/dateUtils';

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
  storedStageColorName(stageNumber) ?? `Stage ${stageNumber}`;
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

type ArcPass = NonNullable<ApiProgressOverview['arc']['passes']>[number];
type PassMarker = ArcPass['markers'][number];

/** One pass drawn as one ribbon row (#3727): oldest on top, aligned week for week. */
export interface PassRow {
  key: string;
  /** The row's header: `Pass 2 · began 1 Jun · in progress — week 8`. */
  label: string;
  blocks: RibbonBlock[];
  /** Weeks drawn in stage colour; the rest of the arc is an unfilled track. */
  drawnWeeks: number;
  /** The live pass's week, drawn as the you-are-here line. */
  currentWeek?: number;
  markers: RibbonMarker[];
  /** The whole row as one sentence for screen readers. */
  summary: string;
}

const ONE_DAY_BACK = -1;
const arcWeeks = (overview: ApiProgressOverview): number =>
  overview.arc.stages.reduce((sum, stage) => sum + stage.weeks, 0);
const dayShort = (date: string): string => format(date, { day: 'numeric', month: 'short' });
const dayLong = (date: string): string =>
  format(date, { day: 'numeric', month: 'long', year: 'numeric' });
const dayBefore = (date: string): string => addDaysInTZ(date, ONE_DAY_BACK, 'UTC');
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * How far an ended pass got. The server sends ``reached_*`` for every begun
 * pass, but the schema allows null, so a missing figure is left unsaid rather
 * than printed: the stage and week, the week alone, or just the day it ended.
 */
function ended(pass: ArcPass): string {
  if (pass.completed) return 'completed';
  const { reached_stage: stage, reached_week: week } = pass;
  if (week === null) return pass.ended_on ? `ended ${dayShort(pass.ended_on)}` : 'ended';
  return stage === null ? `reached week ${week}` : `reached stage ${stage}, week ${week}`;
}

/** How far a begun pass got, in the row's words. */
function reach(pass: ArcPass, until: string | null): string {
  if (pass.state !== 'live') return ended(pass);
  const week = pass.reached_week === null ? '' : ` — week ${pass.reached_week}`;
  return `in progress${week}${until ? `, until ${dayShort(until)}` : ''}`;
}

/** The sentence's middle: where the pass is, or how far it got, out of the arc's weeks. */
function whereSentence(pass: ArcPass, weeks: number): string {
  const week = pass.reached_week;
  if (pass.state === 'live')
    return `In progress${week === null ? '' : `, week ${week} of ${weeks}`}.`;
  if (pass.completed) return `Completed all ${weeks} weeks.`;
  return `${capitalise(ended(pass))}${week === null ? '' : ` of ${weeks}`}.`;
}

/** What a marker's ring means: locked by the pass's end, or locked now on the live pass. */
const lockNote = (pass: ArcPass): string =>
  pass.state === 'live' ? 'locked now' : 'locked by the pass’s end';

const passMarker = (pass: ArcPass, marker: PassMarker): RibbonMarker => ({
  week: marker.week,
  number: marker.program_number,
  hollow: marker.currently_locked,
  label: `Habit ${marker.program_number} · ${marker.name}`,
  unlocked: dayShort(marker.unlocked_on),
  ...(marker.currently_locked ? { note: lockNote(pass) } : {}),
});

function passSentence(pass: ArcPass, weeks: number, numbered: boolean): string {
  const lead = numbered ? `Pass ${pass.pass_number}, began` : 'Began';
  const where = whereSentence(pass, weeks);
  const habits = pass.markers.map(
    (marker) =>
      `habit ${marker.program_number}, ${marker.name}, week ${marker.week}${marker.currently_locked ? `, ${lockNote(pass)}` : ''}`,
  );
  const unlocked =
    habits.length === 0 ? 'No habits unlocked.' : `Habits unlocked: ${habits.join('; ')}.`;
  return `${lead} ${dayLong(pass.started_on)}. ${where} ${unlocked}`;
}

function pendingRow(pass: ArcPass, base: Omit<PassRow, 'label' | 'summary'>, numbered: boolean) {
  const begins = numbered ? `Pass ${pass.pass_number} begins` : 'Begins';
  return {
    ...base,
    drawnWeeks: 0,
    markers: [],
    label: numbered
      ? `Pass ${pass.pass_number} · begins ${dayShort(pass.started_on)}`
      : `Begins ${dayShort(pass.started_on)}`,
    summary: `${begins} ${dayLong(pass.started_on)}, in ${plural(pass.days_until_start, 'day')}.`,
  };
}

/** A lone live pass reads as today's ribbon did, `Week 8 · Red`, saying only what is known. */
function soleLabel(pass: ArcPass): string {
  if (pass.state !== 'live')
    return capitalise(`began ${dayShort(pass.started_on)} · ${reach(pass, null)}`);
  const { reached_stage: stage, reached_week: week } = pass;
  if (week === null) return 'In progress';
  return stage === null ? `Week ${week}` : `Week ${week} · ${stageName(stage)}`;
}

function passRow(
  overview: ApiProgressOverview,
  pass: ArcPass,
  next: ArcPass | undefined,
  numbered: boolean,
): PassRow {
  const weeks = arcWeeks(overview);
  const base = {
    key: `pass-${pass.pass_number}`,
    blocks: ribbonBlocks(overview),
    drawnWeeks: pass.state === 'ended' && !pass.completed ? (pass.reached_week ?? 0) : weeks,
    markers: pass.markers.map((marker) => passMarker(pass, marker)),
  };
  if (pass.state === 'pending') return pendingRow(pass, base, numbered);
  const until = next?.state === 'pending' ? dayBefore(next.started_on) : null;
  return {
    ...base,
    ...(pass.state === 'live' && pass.reached_week !== null
      ? { currentWeek: pass.reached_week }
      : {}),
    label: numbered
      ? `Pass ${pass.pass_number} · began ${dayShort(pass.started_on)} · ${reach(pass, until)}`
      : soleLabel(pass),
    summary: passSentence(pass, weeks, numbered),
  };
}

/**
 * One row per pass, oldest first (#3727). Empty for an older server or with
 * the habits ring off, so the screen keeps the single ribbon. A lone pass is
 * not numbered: a first-time reader sees today's ribbon, plus numbers.
 */
export function passRows(overview: ApiProgressOverview): PassRow[] {
  const passes = overview.arc.passes ?? [];
  const numbered = passes.length > 1;
  return passes.map((pass, index) => passRow(overview, pass, passes[index + 1], numbered));
}

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
