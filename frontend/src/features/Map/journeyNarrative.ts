// frontend/features/Map/journeyNarrative.ts

/**
 * Narrative helpers for the Map's journey read + stage-detail modal.
 *
 * These turn the raw stage-history payload into a single progression sentence
 * and a ranked list of headline stats, so the modal reads as a story rather
 * than a pile of disparate counts. Pure functions — no React, no I/O.
 */

import type { StageHistoryResponse } from '../../api';

/** Compact "Stage N of 10 · Week W" read for the journey header. */
export const journeyRead = (
  currentStage: number,
  currentWeek: number,
  stageCount: number,
): string => `Stage ${currentStage} of ${stageCount} · Week ${currentWeek}`;

/** "Unlocks in N days" / already-reached copy for a locked stage. */
export const unlockTimeline = (daysUntil: number | null): string => {
  if (daysUntil === null) return 'Unlocks as your journey reaches it';
  if (daysUntil <= 0) return 'Unlocking now';
  return `Unlocks in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
};

/** A single ranked headline stat (largest contribution first). */
export interface RankedStat {
  key: string;
  label: string;
  value: number;
}

const MINUTES_PER_HOUR = 60;

/** Total sessions + total minutes + best habit streak, derived once. */
interface JourneyTotals {
  sessions: number;
  minutes: number;
  bestStreak: number;
  practiceCount: number;
  habitCount: number;
}

const totalsFor = (history: StageHistoryResponse): JourneyTotals => {
  const sessions = history.practices.reduce((sum, p) => sum + p.sessions_completed, 0);
  const minutes = history.practices.reduce((sum, p) => sum + p.total_minutes, 0);
  const bestStreak = history.habits.reduce((max, h) => Math.max(max, h.best_streak), 0);
  return {
    sessions,
    minutes,
    bestStreak,
    practiceCount: history.practices.length,
    habitCount: history.habits.length,
  };
};

/**
 * One progression sentence summarising the stage's activity. Reads as a story
 * ("You logged 12 sessions across 1 practice and held a 14-day streak.") rather
 * than a bare count list.
 */
export const progressionSentence = (history: StageHistoryResponse): string => {
  const { sessions, bestStreak, practiceCount, habitCount } = totalsFor(history);
  const clauses: string[] = [];
  if (sessions > 0) {
    clauses.push(
      `logged ${sessions} session${sessions === 1 ? '' : 's'} across ${practiceCount} practice${
        practiceCount === 1 ? '' : 's'
      }`,
    );
  }
  if (bestStreak > 0) {
    clauses.push(`held a ${bestStreak}-day streak`);
  } else if (habitCount > 0) {
    clauses.push(`began building ${habitCount} habit${habitCount === 1 ? '' : 's'}`);
  }
  if (clauses.length === 0) return 'Your story for this stage is just beginning.';
  return `You ${clauses.join(' and ')}.`;
};

/** Headline stats ranked largest-first, dropping zero-value rows. */
export const rankedStats = (history: StageHistoryResponse): RankedStat[] => {
  const { sessions, minutes, bestStreak } = totalsFor(history);
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  return [
    { key: 'sessions', label: 'Sessions', value: sessions },
    { key: 'minutes', label: minutes >= MINUTES_PER_HOUR ? 'Hours' : 'Minutes', value: minutes },
    { key: 'streak', label: 'Best streak (days)', value: bestStreak },
  ]
    .map((stat) =>
      stat.key === 'minutes' && minutes >= MINUTES_PER_HOUR ? { ...stat, value: hours } : stat,
    )
    .filter((stat) => stat.value > 0)
    .sort((a, b) => b.value - a.value);
};
