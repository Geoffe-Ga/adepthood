/**
 * Pure mapping from the server's Habit Story (#3524) to what the sheet draws.
 *
 * The server computes every figure (epic #3519, D19); this module only names
 * them, groups the daily series into the chart primitives' shapes and words
 * each number with its denominator. Nothing here ranks, compares to other
 * people, or calls a gap anything but a rest.
 */
import type { ApiHabitStory } from '@/api';
import type { ChartColumn, HeatCell, HeatStageMarker } from '@/components/charts';
import { STAGE_COLORS, STAGE_ORDER } from '@/design/tokens';
import { dayKeyToInstant } from '@/utils/dateUtils';

type StoryDay = ApiHabitStory['days'][number];
type StoryUnit = ApiHabitStory['continuity']['unit'];
type HeatLevel = HeatCell['level'];

/** D09: words until there is shape. Counted in the habit's own cadence unit. */
export const STORY_CHARTS_MIN = 7;
export const STORY_TIER_STACK_MIN = 14;
export const STORY_PATTERNS_MIN = 28;
/** The headline rate window (D05): one stage of the program. */
export const STORY_RATE_WINDOW_DAYS = 21;
/** At most this many observation lines open the sheet's notes. */
export const STORY_OBSERVATIONS_SHOWN = 3;

const DAYS_PER_WEEK = 7;
const TOP_HEAT_LEVEL = 3;
const MINUS = '−';

const SINGULAR: Record<StoryUnit, string> = { days: 'day', weeks: 'week', months: 'month' };
const WITH_LABEL: Record<StoryUnit, string> = {
  days: 'Days with',
  weeks: 'Weeks with',
  months: 'Months with',
};
const TIER_LEVEL: Record<NonNullable<StoryDay['tier']>, HeatLevel> = {
  low: 1,
  clear: 2,
  stretch: 3,
};
const TIER_NAME: Record<NonNullable<StoryDay['tier']>, string> = {
  low: 'Low',
  clear: 'Clear',
  stretch: 'Stretch',
};
export const TIME_OF_DAY_LABELS = ['Dawn', 'Day', 'Dusk', 'Night'] as const;
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** A server calendar key already names the user's day; never re-zone UTC midnight. */
const calendar = (date: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    dayKeyToInstant(date, 'UTC'),
  );
export const formatStoryDate = (date: string): string =>
  calendar(date, { month: 'short', day: 'numeric' });
export const formatStoryLongDate = (date: string): string =>
  calendar(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** "1 day", "7 days", "3 weeks". */
export const countIn = (count: number, unit: StoryUnit): string =>
  `${count} ${count === 1 ? SINGULAR[unit] : unit}`;

/** Format a whole or fractional amount without trailing zeros. */
const amount = (value: number): string => String(Math.round(value * 100) / 100);

/** Signed change against the previous thirty days, with a true minus sign. */
export const signedDelta = (delta: number): string => {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${MINUS}${Math.abs(delta)}`;
  return '±0';
};

export interface GlanceTile {
  key: 'current' | 'longest' | 'returns' | 'with';
  label: string;
  value: string;
  caption?: string;
}

export function glanceTiles(story: ApiHabitStory): GlanceTile[] {
  const { continuity, rates } = story;
  return [
    {
      key: 'current',
      label: 'Current run',
      value: countIn(continuity.current_run, continuity.unit),
    },
    {
      key: 'longest',
      label: 'Longest run',
      value: countIn(continuity.longest_run, continuity.unit),
    },
    { key: 'returns', label: 'Returns', value: String(continuity.returns) },
    {
      key: 'with',
      label: WITH_LABEL[continuity.unit],
      value: String(continuity.days_with),
      caption: `of ${rates.all_time.scheduled} scheduled`,
    },
  ];
}

/** D05: the rolling stage window as the headline, all time beside it, both with denominators. */
export function rateLine(story: ApiHabitStory): string {
  const { last_21: recent, all_time: all, unit } = story.rates;
  return `${recent.met} of ${recent.scheduled} scheduled ${recent.scheduled === 1 ? SINGULAR[unit] : unit} in the last ${STORY_RATE_WINDOW_DAYS} days · all time ${all.met} of ${all.scheduled}`;
}

/** Whether the habit has enough shape for each chart (D09). */
export function storyDepth(story: ApiHabitStory) {
  const count = story.continuity.days_with;
  return {
    charts: count >= STORY_CHARTS_MIN,
    tierStack: count >= STORY_TIER_STACK_MIN,
    patterns: count >= STORY_PATTERNS_MIN,
  };
}

/** The words that stand in for charts before there is shape. */
export function earlyDaysLine(story: ApiHabitStory, habitName: string): string {
  const [first] = story.observations;
  if (first) return first;
  const { days_with: count, unit } = story.continuity;
  return count === 0
    ? `The shape of ${habitName} appears here after its first ${STORY_CHARTS_MIN} ${unit}.`
    : `${countIn(count, unit)} with ${habitName} so far. The shape appears here after ${STORY_CHARTS_MIN}.`;
}

function dayState(day: StoryDay, unit: string): string {
  if (day.tier) return `${TIER_NAME[day.tier]} · ${amount(day.units)} ${unit}`;
  if (day.logged) return `Logged, under Low · ${amount(day.units)} ${unit}`;
  return day.scheduled ? 'Quiet' : 'Not scheduled';
}

const dayCell = (day: StoryDay, unit: string): HeatCell => ({
  label: `${formatStoryLongDate(day.date)} · ${dayState(day, unit)}`,
  level: day.tier ? TIER_LEVEL[day.tier] : 0,
  hollow: day.logged && day.tier === null,
});

const addDays = (date: string, offset: number): string =>
  new Date(dayKeyToInstant(date, 'UTC').getTime() + offset * 86_400_000).toISOString().slice(0, 10);

/** Monday of the week holding ``date`` (0 = Monday … 6 = Sunday). */
const weekdayIndex = (date: string): number => (dayKeyToInstant(date, 'UTC').getUTCDay() + 6) % 7;

export interface StoryHeatGrid {
  weeks: HeatCell[][];
  weekStarts: string[];
  markers: HeatStageMarker[];
  columnLabels: string[];
}

/** Monday-start week columns of tier cells, padded before the first represented day. */
export function heatGrid(story: ApiHabitStory): StoryHeatGrid {
  const weeks: HeatCell[][] = [];
  const weekStarts: string[] = [];
  const first = story.days[0];
  if (first) {
    const lead = weekdayIndex(first.date);
    const padding = Array.from({ length: lead }, (_, index) => ({
      label: `${formatStoryLongDate(addDays(first.date, index - lead))} · before this record`,
      level: 0 as HeatLevel,
    }));
    const cells = [...padding, ...story.days.map((day) => dayCell(day, story.unit))];
    for (let start = 0; start < cells.length; start += DAYS_PER_WEEK) {
      weeks.push(cells.slice(start, start + DAYS_PER_WEEK));
      weekStarts.push(addDays(first.date, start - lead));
    }
  }
  const markers = story.stages.flatMap((stage) => {
    const name = STAGE_ORDER[stage.stage_number - 1];
    const column = weekStarts.filter((start) => start <= stage.opens_on).length - 1;
    if (!name || column < 0) return [];
    return [{ label: name, color: STAGE_COLORS[name] ?? '', columnIndex: column }];
  });
  const firstStart = weekStarts[0];
  const lastStart = weekStarts.at(-1);
  const columnLabels =
    firstStart && lastStart && weekStarts.length > 1
      ? [formatStoryDate(firstStart), formatStoryDate(lastStart)]
      : [];
  return { weeks, weekStarts, markers, columnLabels };
}

/** The caption under the day grid: which weeks its columns cover. */
export const gridRange = (grid: StoryHeatGrid): string =>
  `A column per week, from the week of ${grid.columnLabels[0]} to the week of ${grid.columnLabels.at(-1)}.`;

export function heatSummary(story: ApiHabitStory, habitName: string): string {
  const { low, clear, stretch, under } = story.tiers.totals;
  return `${habitName}, day by day from ${formatStoryDate(story.days[0]?.date ?? story.start_date)} to ${formatStoryDate(story.today)}. ${low} Low, ${clear} Clear and ${stretch} Stretch days; ${under} logged under Low.`;
}

export interface TierTile {
  key: 'low' | 'clear' | 'stretch';
  label: string;
  value: number;
  delta: string;
}

export function tierTiles(story: ApiHabitStory): TierTile[] {
  const { totals, last_30_delta: delta } = story.tiers;
  return (['low', 'clear', 'stretch'] as const).map((key) => ({
    key,
    label: `${TIER_NAME[key]} days`,
    value: totals[key],
    delta: signedDelta(delta[key]),
  }));
}

/**
 * Weekly stacked tier days (D07): Low, Clear, Stretch segments with quiet days
 * beside. No week is dimmed: a faded Clear segment would read as Low.
 */
export const tierColumns = (story: ApiHabitStory): ChartColumn[] =>
  story.tiers.weekly.map((week) => ({
    label: `Week of ${formatStoryDate(week.week_start)}`,
    segments: [week.low, week.clear, week.stretch],
    quiet: week.quiet,
  }));

export function tierStackSummary(story: ApiHabitStory): string {
  const latest = story.tiers.weekly.at(-1);
  const weeks = story.tiers.weekly.length;
  if (!latest) return 'No weeks recorded yet.';
  return `Tier days per week for ${weeks} weeks. The latest week has ${latest.low} Low, ${latest.clear} Clear and ${latest.stretch} Stretch days.`;
}

const heatLevel = (value: number, max: number): HeatLevel =>
  value <= 0 || max <= 0
    ? 0
    : (Math.max(1, Math.ceil((value / max) * TOP_HEAT_LEVEL)) as HeatLevel);

/** D08: one column per time of day, one row per weekday (Monday first). */
export function patternGrid(story: ApiHabitStory): HeatCell[][] {
  const matrix = story.patterns.weekday_by_time_of_day;
  const max = Math.max(0, ...matrix.flat());
  return TIME_OF_DAY_LABELS.map((time, column) =>
    WEEKDAY_NAMES.map((weekday, row) => {
      const value = matrix[row]?.[column] ?? 0;
      return {
        label: `${weekday} · ${time} · ${amount(value)} ${story.unit}`,
        level: heatLevel(value, max),
      };
    }),
  );
}

export function patternSummary(story: ApiHabitStory): string {
  const matrix = story.patterns.weekday_by_time_of_day;
  let best = { value: 0, label: '' };
  matrix.forEach((row, weekday) =>
    row.forEach((value, time) => {
      if (value > best.value)
        best = { value, label: `${WEEKDAY_NAMES[weekday]} ${TIME_OF_DAY_LABELS[time]}` };
    }),
  );
  return best.value > 0
    ? `Units logged by weekday and time of day. Most often on ${best.label}.`
    : 'Units logged by weekday and time of day. No timed logs yet.';
}

/** The one-line caveat under the pattern grid when some units have no known time. */
export function unknownTimeNote(story: ApiHabitStory): string | null {
  const { unknown_time_units: unknown, time_of_day_available_since: since } = story.patterns;
  if (unknown <= 0) return null;
  return since
    ? `Times are known for logs since ${formatStoryDate(since)}.`
    : 'Times are kept for logs from the next check-in on.';
}

type StoryMilestone = ApiHabitStory['milestones'][number];

/** Words for a dated milestone (#3525's kinds); an unrecognised kind is left out rather than guessed. */
export function milestoneText(milestone: StoryMilestone, story: ApiHabitStory): string | null {
  const unit = story.continuity.unit;
  switch (milestone.kind) {
    case 'days_with':
      return `${countIn(milestone.value, unit)} with this habit`;
    case 'first_stretch':
      return 'A first Stretch day';
    case 'return':
      return `Back after ${countIn(milestone.value, 'days')}. The record kept your place.`;
    case 'stage_complete': {
      const stage = STAGE_ORDER[milestone.value - 1];
      return stage ? `Kept through ${stage}` : null;
    }
    default:
      return null;
  }
}

export interface DatedMilestone {
  date: string;
  text: string;
}

export const datedMilestones = (story: ApiHabitStory): DatedMilestone[] =>
  story.milestones.flatMap((milestone) => {
    const text = milestoneText(milestone, story);
    return text === null ? [] : [{ date: formatStoryDate(milestone.reached_on), text }];
  });

export interface StoryLogLine {
  key: string;
  when: string;
  amount: string;
  detail: string;
}

/** How a log arrived, in words; an unknown source is named as logged. */
const SOURCE_WORDS: Record<string, string> = {
  manual: 'logged by hand',
  timer: 'with the timer',
  journal: 'from a journal entry',
  practice_link: 'from a practice sit',
  backfill: 'added for an earlier day',
};
const sourceWords = (source: string, viaTimer: boolean): string =>
  viaTimer ? SOURCE_WORDS.timer! : (SOURCE_WORDS[source] ?? 'logged');

/** The Ledger stub's raw log list, newest first as the server sends it. */
export const logLines = (
  story: ApiHabitStory,
  formatTime: (_timestamp: string) => string,
): StoryLogLine[] =>
  story.logs.map((log, index) => ({
    key: `${log.timestamp}-${index}`,
    when: `${formatStoryDate(log.local_day)} · ${formatTime(log.timestamp)}`,
    amount: `${log.delta_units > 0 ? '+' : log.delta_units < 0 ? MINUS : ''}${amount(Math.abs(log.delta_units))} ${story.unit}`,
    detail: sourceWords(log.source, log.via_timer),
  }));
