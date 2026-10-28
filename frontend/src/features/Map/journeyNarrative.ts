/**
 * Narrative helpers for the Map's journey read + stage-detail modal.
 *
 * These turn the raw stage-history payload into a single progression sentence
 * and a fixed list of headline stats, so the modal reads as a story rather
 * than a pile of disparate counts. Pure functions — no React, no I/O.
 */

import type { StageHistoryResponse } from '../../api';

/** Wheel-not-ladder framing shared by every Map drawer state. */
export const MAP_LEAD =
  'The Map is a wheel, not a ladder: its ten stages revisit different capacities, never ranking you or the stages.';

/** Compact "Stage N of 10 · Week W" read for the journey header. */
export const journeyRead = (
  currentStage: number,
  currentWeek: number,
  stageCount: number,
): string => `Stage ${currentStage} of ${stageCount} · Week ${currentWeek}`;

/** "Opens in N days" / already-reached copy for a stage the calendar has not reached. */
export const unlockTimeline = (daysUntil: number | null): string => {
  if (daysUntil === null) return 'Opens with the course';
  if (daysUntil <= 0) return 'Opening now';
  return `Opens in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
};

/** A headline stat for the stage modal, in a fixed order (never ranked by size). */
export interface RankedStat {
  key: string;
  label: string;
  value: number;
}

const MINUTES_PER_HOUR = 60;

/** Human-friendly duration: whole minutes under an hour, else rounded hours. */
export const formatMinutes = (minutes: number): string => {
  const wholeMinutes = Math.round(minutes);
  if (wholeMinutes >= MINUTES_PER_HOUR) {
    const hours = Math.round(minutes / MINUTES_PER_HOUR);
    return `${hours} hr${hours === 1 ? '' : 's'}`;
  }
  return `${wholeMinutes} min`;
};

type RunUnit = 'days' | 'weeks' | 'months';
const SINGULAR: Record<RunUnit, string> = { days: 'day', weeks: 'week', months: 'month' };

/** Total sessions + total minutes + the longest habit run and its unit, derived once. */
interface JourneyTotals {
  sessions: number;
  minutes: number;
  longestRun: number;
  runUnit: RunUnit;
  practiceCount: number;
  habitCount: number;
}

const totalsFor = (history: StageHistoryResponse): JourneyTotals => {
  const sessions = history.practices.reduce((sum, p) => sum + p.sessions_completed, 0);
  const minutes = history.practices.reduce((sum, p) => sum + p.total_minutes, 0);
  const longest = history.habits.reduce<(typeof history.habits)[number] | null>(
    (best, habit) => (best === null || habit.best_streak > best.best_streak ? habit : best),
    null,
  );
  return {
    sessions,
    minutes,
    longestRun: longest?.best_streak ?? 0,
    runUnit: longest?.cadence_unit ?? 'days',
    practiceCount: history.practices.length,
    habitCount: history.habits.length,
  };
};

/** "14 days", "1 week": a run counted in its habit's own cadence (#3528). */
const runLength = (count: number, unit: RunUnit): string =>
  `${count} ${count === 1 ? SINGULAR[unit] : unit}`;

/**
 * One progression sentence summarising the stage's activity. Reads as a story
 * ("You logged 12 sessions across 1 practice and kept a run of 14 days.")
 * rather than a bare count list, and never says "streak" (ADR 0003).
 */
export const progressionSentence = (history: StageHistoryResponse): string => {
  const { sessions, longestRun, runUnit, practiceCount, habitCount } = totalsFor(history);
  const clauses: string[] = [];
  if (sessions > 0) {
    clauses.push(
      `logged ${sessions} session${sessions === 1 ? '' : 's'} across ${practiceCount} practice${
        practiceCount === 1 ? '' : 's'
      }`,
    );
  }
  if (longestRun > 0) {
    clauses.push(`kept a run of ${runLength(longestRun, runUnit)}`);
  } else if (habitCount > 0) {
    clauses.push(`began building ${habitCount} habit${habitCount === 1 ? '' : 's'}`);
  }
  if (clauses.length === 0) return 'Your story for this stage is just beginning.';
  return `You ${clauses.join(' and ')}.`;
};

/**
 * The stage's headline stats in a fixed order -- sessions, time, longest run --
 * dropping zero rows. Never sorted by size: ADR 0003 bans ranking figures.
 */
export const rankedStats = (history: StageHistoryResponse): RankedStat[] => {
  const { sessions, minutes, longestRun, runUnit } = totalsFor(history);
  const inHours = minutes >= MINUTES_PER_HOUR;
  return [
    { key: 'sessions', label: 'Sessions', value: sessions },
    {
      key: 'minutes',
      label: inHours ? 'Hours' : 'Minutes',
      value: inHours ? Math.round(minutes / MINUTES_PER_HOUR) : minutes,
    },
    { key: 'run', label: `Longest run (${runUnit})`, value: longestRun },
  ].filter((stat) => stat.value > 0);
};
