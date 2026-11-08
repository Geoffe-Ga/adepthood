/**
 * The range a start-date picker may offer (#3097).
 *
 * The server sends the exact window on ``program_start_window``; its floor
 * (account creation minus one whole program) is fixed, so the client keeps it.
 * The ceiling is always today in the account zone -- the server's own ``latest``
 * is today as of the read that sent it, and a cached one would forbid today
 * after midnight. With no server window yet, the floor falls back to today minus
 * the window, which is never earlier than the server's.
 */
import { useMemo } from 'react';

import type { ProgramStartWindow } from '../../api';
import { PROGRAM_START_BACKDATE_WINDOW_DAYS } from '../../constants/program';
import { useProgramStore } from '../../store/useProgramStore';
import { addDaysInTZ } from '../../utils/dateUtils';
import { useDayKey } from '../../utils/dayRollover';

export interface ProgramStartRange {
  /** Earliest pickable day, ``YYYY-MM-DD`` in the account zone. */
  minDay: string;
  /** Latest pickable day: today in the account zone. */
  maxDay: string;
  /** Cycle 2 and later: the date is fixed and no picker is offered. */
  locked: boolean;
}

export function programStartRange(
  window: ProgramStartWindow | null,
  locked: boolean,
  today: string,
  tz: string,
): ProgramStartRange {
  const minDay = window?.earliest ?? addDaysInTZ(today, -PROGRAM_START_BACKDATE_WINDOW_DAYS, tz);
  return { minDay, maxDay: today, locked };
}

/**
 * The day a picker should open on: ``day``, unless it is after today -- the
 * legacy case of an anchor the old, future-only picker allowed, which the
 * server now refuses. An early day is left alone: it is a date the person
 * already holds, and moving it silently would move their whole calendar.
 */
export function notAfterToday(day: string, range: Pick<ProgramStartRange, 'maxDay'>): string {
  return day > range.maxDay ? range.maxDay : day;
}

/**
 * The floor a picker offers while showing ``displayedDay``: the range's floor,
 * or the displayed day when that is earlier, so the picker never refuses to
 * give back the date it is showing.
 */
export function pickerFloor(
  range: Pick<ProgramStartRange, 'minDay'>,
  displayedDay: string,
): string {
  return displayedDay < range.minDay ? displayedDay : range.minDay;
}

/**
 * The current pickable range, from the adopted server window. "Today" comes from
 * the shared day-rollover owner, so a picker left open across local midnight
 * re-renders with the new ceiling rather than refusing the day it now is.
 */
export function useProgramStartRange(tz: string): ProgramStartRange {
  const window = useProgramStore((s) => s.programStartWindow);
  const locked = useProgramStore((s) => s.programStartLocked);
  const today = useDayKey(tz);
  return useMemo(() => programStartRange(window, locked, today, tz), [window, locked, today, tz]);
}
