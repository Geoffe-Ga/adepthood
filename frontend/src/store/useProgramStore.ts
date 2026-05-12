// Master clock for the 36-week journey: drives BotMason week, active practice, course unlock, and map stage.
import { useEffect } from 'react';
import { create } from 'zustand';

import { STAGE_DURATIONS_DAYS } from '../constants/program';
import {
  clearProgramStartDate,
  loadProgramStartDate,
  saveProgramStartDate,
} from '../storage/programStorage';

import { registerStoreReset } from './registry';

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_WEEK = 7;
const STAGE_COUNT = STAGE_DURATIONS_DAYS.length;
const TOTAL_PROGRAM_DAYS = STAGE_DURATIONS_DAYS.reduce((sum, d) => sum + d, 0);
// Integer-pinned so a future non-7-multiple change to STAGE_DURATIONS_DAYS can't silently leak fractional weeks.
const TOTAL_PROGRAM_WEEKS = Math.floor(TOTAL_PROGRAM_DAYS / DAYS_PER_WEEK);

export interface ProgramStoreState {
  programStartDate: Date | null;
  setProgramStartDate: (_date: Date | null) => void;
  // Seed from storage on boot without re-writing it.
  hydrateProgramStartDate: (_date: Date | null) => void;
  // BUG-FE-STATE-001: wipe on logout. Also clears persisted storage.
  reset: () => void;
}

const INITIAL_STATE = {
  programStartDate: null as Date | null,
};

const normalize = (date: Date): Date => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const persistAsync = (date: Date | null): void => {
  const op = date === null ? clearProgramStartDate() : saveProgramStartDate(date);
  op.catch((err) => {
    console.warn('[useProgramStore] failed to persist program start date', err);
  });
};

export const useProgramStore = create<ProgramStoreState>((set) => ({
  ...INITIAL_STATE,

  setProgramStartDate: (date) => {
    const normalized = date === null ? null : normalize(date);
    set({ programStartDate: normalized });
    persistAsync(normalized);
  },
  hydrateProgramStartDate: (date) => {
    const normalized = date === null ? null : normalize(date);
    set({ programStartDate: normalized });
  },
  reset: () => {
    set({ ...INITIAL_STATE });
    persistAsync(null);
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
