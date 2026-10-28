import type { PracticeStoryMilestone, PracticeStoryResponse } from '@/api';
import type { ChartColumn, ChartPoint, HBar } from '@/components/charts';
import { MODE_CATEGORIES } from '@/features/Practice/components/ModePicker';
import { dayKeyInTZ, dayKeyToInstant, formatTimeInTZ } from '@/utils/dateUtils';

const MINUTES_PER_HOUR = 60;
export function formatPracticeMinutes(minutes: number): string {
  if (minutes > 0 && minutes < 1) return '<1 min';
  const rounded = Math.round(minutes);
  return rounded < MINUTES_PER_HOUR
    ? `${rounded} min`
    : `${Math.floor(rounded / MINUTES_PER_HOUR)} h ${rounded % MINUTES_PER_HOUR} m`;
}
/** A server calendar key already names the user's day; never re-zone UTC midnight. */
export const formatCalendarDate = (date: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dayKeyToInstant(date, 'UTC'));
export const formatStoryTimestamp = (timestamp: string, timezone: string): string =>
  `${formatCalendarDate(dayKeyInTZ(timestamp, timezone))} · ${formatTimeInTZ(new Date(timestamp), timezone)}`;
const modeName = (mode: string): string =>
  MODE_CATEGORIES.flatMap((category) => category.modes).find((entry) => entry.mode === mode)
    ?.label ?? 'Other practice';
export const storyColumns = (story: PracticeStoryResponse): ChartColumn[] =>
  story.weekly.map((week, index) => ({
    label: formatCalendarDate(week.week_start),
    segments: [week.count],
    emphasis: index === story.weekly.length - 1,
  }));
export const storyPoints = (story: PracticeStoryResponse, timezone: string): ChartPoint[] =>
  story.recent_sits.map((sit) => ({
    label: formatStoryTimestamp(sit.timestamp, timezone),
    value: sit.duration_minutes,
    hollow: !sit.completed,
    stateLabel: sit.completed ? 'Completed' : 'Ended early',
  }));
export const timeOfDayBars = (story: PracticeStoryResponse): HBar[] => [
  { label: 'Dawn', value: story.time_of_day.dawn },
  { label: 'Day', value: story.time_of_day.day },
  { label: 'Dusk', value: story.time_of_day.dusk },
  { label: 'Night', value: story.time_of_day.night },
];
export const modeBars = (story: PracticeStoryResponse): HBar[] =>
  Object.entries(story.modes).map(([mode, value]) => ({ label: modeName(mode), value }));
export function milestoneText(milestone: PracticeStoryMilestone): string | null {
  const date = formatCalendarDate(milestone.reached_on);
  if (milestone.kind === 'practice_minutes')
    return `${formatPracticeMinutes(milestone.value)} in practice · ${date}`;
  if (milestone.kind === 'practice_sessions') return `${milestone.value} sits · ${date}`;
  return null;
}
