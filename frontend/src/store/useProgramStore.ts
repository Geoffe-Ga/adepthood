/**
 * Program store -- the master clock for the 36-week APTITUDE journey.
 *
 * ``programStartDate`` is the user-chosen anchor (set via the
 * ReorderHabitsModal start-date picker, or the onboarding flow).  Once
 * set, it drives:
 *
 *   * the current week BotMason shows in the weekly prompt banner;
 *   * the practice that the Practice screen pre-selects;
 *   * which course content is unlocked / next on the Course screen;
 *   * the highlighted stage on the Map.
 *
 * Past dates are allowed (the user may have started the program before
 * installing the app and want today to land on Week 5, etc.).  Future
 * dates clamp every consumer to Stage 1 / Week 1 (pre-program state) so
 * the UI never advances ahead of the anchor.
 *
 * The store is a dumb in-memory container; persistence to AsyncStorage
 * lives in ``src/storage/programStorage.ts`` and is invoked from the
 * actions below so write-through is automatic.
 */

import { create } from 'zustand';

import { STAGE_DURATIONS_DAYS } from '../features/Habits/HabitUtils';
import { clearProgramStartDate, saveProgramStartDate } from '../storage/programStorage';

import { registerStoreReset } from './registry';

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_WEEK = 7;
const STAGE_COUNT = STAGE_DURATIONS_DAYS.length;
const TOTAL_PROGRAM_DAYS = STAGE_DURATIONS_DAYS.reduce((sum, d) => sum + d, 0);
const TOTAL_PROGRAM_WEEKS = TOTAL_PROGRAM_DAYS / DAYS_PER_WEEK;

export interface ProgramStoreState {
  /**
   * The user-chosen master anchor date (local calendar day), or ``null``
   * when the user hasn't set one yet.  Stored as a ``Date`` for ergonomic
   * arithmetic; serialised as ``YYYY-MM-DD`` in AsyncStorage.
   */
  programStartDate: Date | null;

  /** Set the anchor; persists to AsyncStorage. ``null`` clears the anchor. */
  setProgramStartDate: (_date: Date | null) => void;
  /**
   * Synchronously seed the store after hydrating from storage on app
   * start.  Skips the persistence write -- the value already lives on
   * disk -- so we don't churn AsyncStorage on every boot.
   */
  hydrateProgramStartDate: (_date: Date | null) => void;
  /** BUG-FE-STATE-001: wipe state on logout. Also clears persisted storage. */
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

// ---------------------------------------------------------------------------
// Selectors and derived helpers.
//
// The selectors below are pure functions of ``programStartDate`` plus the
// caller-supplied ``today`` (defaulting to ``new Date()``).  Threading
// ``today`` as an argument keeps the helpers deterministic for tests and
// lets a future "time travel" debug toggle override the clock without
// patching ``Date``.
// ---------------------------------------------------------------------------

export const selectProgramStartDate = (state: ProgramStoreState): Date | null =>
  state.programStartDate;

/**
 * Whole calendar-day offset between ``today`` and the anchor.  Negative
 * when the anchor is still in the future; clamped to ``>= 0`` by every
 * consumer below so a future anchor never advances the UI past Week 1.
 */
export const programDayOffset = (anchor: Date | null, today: Date = new Date()): number | null => {
  if (anchor === null) return null;
  const a = normalize(anchor).getTime();
  const t = normalize(today).getTime();
  return Math.floor((t - a) / MS_PER_DAY);
};

/**
 * Current program week (1-36) given the anchor.  Returns ``null`` when
 * no anchor is set.  Clamps below to 1 (anchor in the future) and above
 * to 36 (program already complete).
 */
export const programWeek = (anchor: Date | null, today: Date = new Date()): number | null => {
  const offset = programDayOffset(anchor, today);
  if (offset === null) return null;
  if (offset < 0) return 1;
  const week = Math.floor(offset / DAYS_PER_WEEK) + 1;
  if (week > TOTAL_PROGRAM_WEEKS) return TOTAL_PROGRAM_WEEKS;
  return week;
};

/**
 * Current stage number (1-10) given the anchor.  Walks
 * ``STAGE_DURATIONS_DAYS`` so the 21-day / 42-day split is honoured.
 * Returns ``null`` when no anchor is set.
 */
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
