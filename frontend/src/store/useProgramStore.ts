// Master clock for the 36-week journey: drives BotMason week, active practice, course unlock, and map stage.
//
// The SERVER owns the anchor (#3097): ``program_started_at`` on the progress row,
// which the person picks through ``PUT /stages/program-calendar``. This store is
// its cached mirror -- written from the server by ``adoptServerProgramStart``
// (only via ``src/features/Program``), restored from AsyncStorage on cold start,
// and derived from the habit rows only as the offline / no-server-row fallback.
import { useEffect } from 'react';
import { create } from 'zustand';

import type { ProgramStartWindow } from '../api';
import { STAGE_DURATIONS_DAYS, TOTAL_PROGRAM_DAYS } from '../constants/program';
import { clearPendingProgramStart } from '../storage/pendingProgramStart';
import {
  clearProgramStartDate,
  loadProgramStartDate,
  saveProgramStartDate,
} from '../storage/programStorage';
import { MS_PER_DAY } from '../utils/dateUtils';

import { registerStoreReset } from './registry';

import { reportDiagnostic } from '@/observability/diagnostics';

const DAYS_PER_WEEK = 7;
const STAGE_COUNT = STAGE_DURATIONS_DAYS.length;
// Integer-pinned so a future non-7-multiple change to STAGE_DURATIONS_DAYS can't silently leak fractional weeks.
export const TOTAL_PROGRAM_WEEKS = Math.floor(TOTAL_PROGRAM_DAYS / DAYS_PER_WEEK);

/**
 * Where the anchor on hand came from. ``server`` outranks the others: once the
 * server's answer has been adopted, a late storage hydrate must not undo it.
 */
export type ProgramAnchorSource = 'server' | 'storage' | 'local';

/** The server's view of the start-date picker, adopted with the anchor. */
export interface ServerProgramStart {
  /** The anchor as a YYYY-MM-DD in the account zone, or null when the server has none. */
  day: string | null;
  /** The pickable range, or null when unknown (or locked). */
  window: ProgramStartWindow | null;
  /** Cycle 2 and later: the start date is fixed. */
  locked: boolean;
}

export interface ProgramStoreState {
  /** Canonical calendar identity; Dates cannot preserve this across unlike account/device zones. */
  programStartDay: string | null;
  programStartDate: Date | null;
  anchorSource: ProgramAnchorSource | null;
  programStartWindow: ProgramStartWindow | null;
  programStartLocked: boolean;
  setProgramStartDate: (_date: Date | null) => void;
  /** Set an already-zoned YYYY-MM-DD received or derived at an API boundary. */
  setProgramStartDay: (_day: string | null) => void;
  // Seed from storage on boot without re-writing it. A no-op once the server's anchor is adopted.
  hydrateProgramStartDate: (_date: Date | null) => void;
  /** Mirror the server's anchor and window (#3097). Called only from ``src/features/Program``. */
  adoptServerProgramStart: (_server: ServerProgramStart) => void;
  // BUG-FE-STATE-001: wipe on logout. Also clears persisted storage.
  reset: () => void;
}

const INITIAL_STATE = {
  programStartDay: null as string | null,
  programStartDate: null as Date | null,
  anchorSource: null as ProgramAnchorSource | null,
  programStartWindow: null as ProgramStartWindow | null,
  programStartLocked: false,
};

const normalize = (date: Date): Date => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const localDayKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const localDateFromDayKey = (dayKey: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

const persistAsync = (date: Date | null): void => {
  const op = date === null ? clearProgramStartDate() : saveProgramStartDate(date);
  op.catch(() => {
    reportDiagnostic('storage_write_failed', { storage: 'program' });
  });
};

const dayState = (day: string | null) => {
  const normalized = day === null ? null : localDateFromDayKey(day);
  return { programStartDay: normalized === null ? null : day, programStartDate: normalized };
};

export const useProgramStore = create<ProgramStoreState>((set, get) => ({
  ...INITIAL_STATE,

  setProgramStartDate: (date) => {
    const normalized = date === null ? null : normalize(date);
    set({
      programStartDay: normalized === null ? null : localDayKey(normalized),
      programStartDate: normalized,
      anchorSource: 'local',
    });
    persistAsync(normalized);
  },
  setProgramStartDay: (day) => {
    const next = dayState(day);
    set({ ...next, anchorSource: 'local' });
    persistAsync(next.programStartDate);
  },
  hydrateProgramStartDate: (date) => {
    if (get().anchorSource === 'server') return;
    const normalized = date === null ? null : normalize(date);
    set({
      programStartDay: normalized === null ? null : localDayKey(normalized),
      programStartDate: normalized,
      anchorSource: normalized === null ? null : 'storage',
    });
  },
  adoptServerProgramStart: ({ day, window, locked }) => {
    set({ programStartWindow: window, programStartLocked: locked });
    if (day === null) return;
    const next = dayState(day);
    if (next.programStartDate === null) return;
    set({ ...next, anchorSource: 'server' });
    persistAsync(next.programStartDate);
  },
  reset: () => {
    set({ ...INITIAL_STATE });
    persistAsync(null);
    // A pick held for retry belongs to the account that made it.
    clearPendingProgramStart().catch(() => {
      reportDiagnostic('storage_write_failed', { storage: 'program' });
    });
  },
}));

registerStoreReset(() => {
  useProgramStore.getState().reset();
});

export const selectProgramStartDate = (state: ProgramStoreState): Date | null =>
  state.programStartDate;

// Whole calendar-day offset; negative when the anchor is still in the future.
export const programDayOffset = (anchor: Date | null, today: Date = new Date()): number | null => {
  if (anchor === null) return null;
  const a = normalize(anchor).getTime();
  const t = normalize(today).getTime();
  return Math.floor((t - a) / MS_PER_DAY);
};

// Current program week (1-36), or null when no anchor. Future anchors clamp to 1; finished programs clamp to 36.
export const programWeek = (anchor: Date | null, today: Date = new Date()): number | null => {
  const offset = programDayOffset(anchor, today);
  if (offset === null) return null;
  if (offset < 0) return 1;
  const week = Math.floor(offset / DAYS_PER_WEEK) + 1;
  if (week > TOTAL_PROGRAM_WEEKS) return TOTAL_PROGRAM_WEEKS;
  return week;
};

// Cumulative day offset at which a 1-based stage *begins* (stage 1 starts at day 0).
const stageStartDay = (stageNumber: number): number => {
  let start = 0;
  for (let i = 0; i < stageNumber - 1 && i < STAGE_COUNT; i += 1) {
    start += STAGE_DURATIONS_DAYS[i]!;
  }
  return start;
};

// Whole days until ``stageNumber`` unlocks on the calendar, or null when no anchor.
// 0 (or negative) means the stage has already been reached — callers treat <= 0 as unlocked.
export const daysUntilStage = (
  stageNumber: number,
  anchor: Date | null,
  today: Date = new Date(),
): number | null => {
  const offset = programDayOffset(anchor, today);
  if (offset === null) return null;
  return stageStartDay(stageNumber) - offset;
};

// Current stage (1-10) walking STAGE_DURATIONS_DAYS so the 21/42-day split is honoured.
export const programStage = (anchor: Date | null, today: Date = new Date()): number | null => {
  const offset = programDayOffset(anchor, today);
  if (offset === null) return null;
  if (offset < 0) return 1;
  let remaining = offset;
  for (let i = 0; i < STAGE_COUNT; i += 1) {
    const duration = STAGE_DURATIONS_DAYS[i]!;
    if (remaining < duration) return i + 1;
    remaining -= duration;
  }
  return STAGE_COUNT;
};

// Stage (1-10) containing a 1-based program week, walking STAGE_DURATIONS_DAYS so the
// three-week and six-week stages are both honoured — an even three-per-stage division
// puts the second half of the program a stage early. Total (never throws): weeks below
// the first and past the last clamp to stage 1 and the final stage.
export const programStageForWeek = (week: number): number => {
  let remaining = Math.max(1, Math.trunc(week)) - 1;
  for (let i = 0; i < STAGE_COUNT; i += 1) {
    const weeksInStage = STAGE_DURATIONS_DAYS[i]! / DAYS_PER_WEEK;
    if (remaining < weeksInStage) return i + 1;
    remaining -= weeksInStage;
  }
  return STAGE_COUNT;
};

// Hydrate the anchor from AsyncStorage on cold start so the first paint uses the real value, not the server fallback.
export function useHydrateProgramStore(): void {
  const hydrate = useProgramStore((s) => s.hydrateProgramStartDate);
  useEffect(() => {
    let cancelled = false;
    void loadProgramStartDate().then((date) => {
      if (!cancelled) hydrate(date);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);
}
