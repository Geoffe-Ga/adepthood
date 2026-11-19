/**
 * The range a start-date picker may offer (#3097, #3728).
 *
 * The server sends the exact window on ``program_start_window`` -- the range
 * that corrects the pass the person is in -- and ``pass_start_window`` -- the
 * range a scaffolding save may open a new pass in. Both reach one whole program
 * past today (#3725), so a future day is pickable; the client never computes a
 * window itself when the server has served one. With no server window yet, the
 * program floor falls back to today minus the window and the ceiling to today,
 * both never wider than the server's.
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
  /** Latest pickable day: the server window's end, else today in the account zone. */
  maxDay: string;
  /** Today in the account zone, the day a picker with nothing held opens on. */
  today: string;
  /** No correction is offered: in cycle 2 and later the date is fixed. */
  locked: boolean;
  /**
   * The day a pending next pass begins, or null. While one is pending, a
   * screen offers that day instead of a correction (#3747): the server's PUT
   * would drop the pending pass.
   */
  pendingPassDay: string | null;
}

/**
 * The range that corrects the pass the person is in. ``pendingPassDay`` is
 * carried alongside: while a pass is pending, the start-date screens offer
 * that pass's day rather than this correction, which would drop it (#3747).
 */
export function programStartRange(
  window: ProgramStartWindow | null,
  locked: boolean,
  today: string,
  tz: string,
  pendingPassDay: string | null = null,
): ProgramStartRange {
  const minDay = window?.earliest ?? addDaysInTZ(today, -PROGRAM_START_BACKDATE_WINDOW_DAYS, tz);
  return {
    minDay,
    maxDay: window?.latest ?? today,
    today,
    locked,
    pendingPassDay,
  };
}

/** The calendar day after ``day``, both ``YYYY-MM-DD`` (zone-free day arithmetic). */
const dayAfter = (day: string): string => addDaysInTZ(day, 1, 'UTC');

/**
 * The range a scaffolding save may open a new pass in (#3728), in any cycle --
 * opening a pass is never locked.
 *
 * The served ``pass_start_window`` reaches down to the running pass's own
 * start, which the server accepts; a pass opened there would close the running
 * one before it ran a single day. So the floor moves one day up whenever it IS
 * that start (``runningStart``, the anchor in force) -- which also covers a
 * second save on the day a pass began. With no window served, the one day
 * offered is today, or tomorrow when the running pass began today or its start
 * is unknown: never the running start, never before it.
 */
export function passStartRange(
  window: ProgramStartWindow | null,
  today: string,
  runningStart: string | null,
): ProgramStartRange {
  const base = { today, locked: false, pendingPassDay: null };
  if (window === null) {
    const only = runningStart === null || runningStart === today ? dayAfter(today) : today;
    return { ...base, minDay: only, maxDay: only };
  }
  const minDay = window.earliest === runningStart ? dayAfter(window.earliest) : window.earliest;
  return { ...base, minDay, maxDay: window.latest };
}

/**
 * The day a picker should open on: ``day``, unless it is past the range's end
 * -- a held day the server's window no longer reaches. An early day is left
 * alone: it is a date the person already holds, and moving it silently would
 * move their whole calendar.
 */
export function notAfterLatest(day: string, range: Pick<ProgramStartRange, 'maxDay'>): string {
  return day > range.maxDay ? range.maxDay : day;
}

/**
 * The day a scaffolding save that opens a pass offers first (#3728): the pass
 * already held for the future, so saving again keeps it unless the person
 * changes it, else today. Pulled inside the window from either side, because a
 * new pass -- unlike a held anchor -- has no earlier date to give back.
 */
export function scaffoldOpeningDay(pending: string | null, range: ProgramStartRange): string {
  const day = pending ?? range.today;
  if (day < range.minDay) return range.minDay;
  return notAfterLatest(day, range);
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
 * The current pickable range for correcting the pass the person is in, from
 * the adopted server window. "Today" comes from the shared day-rollover owner,
 * so a picker left open across local midnight re-renders with the new day.
 */
export function useProgramStartRange(tz: string): ProgramStartRange {
  const window = useProgramStore((s) => s.programStartWindow);
  const locked = useProgramStore((s) => s.programStartLocked);
  const pending = useProgramStore((s) => s.pendingPassStartsOn);
  const today = useDayKey(tz);
  return useMemo(
    () => programStartRange(window, locked, today, tz, pending),
    [window, locked, today, tz, pending],
  );
}

/**
 * The range the Energy Scaffolding picker offers (#3728): the pass window when
 * the save opens a new pass, the program window when it is the first save of a
 * first cycle and so corrects pass 1 itself. That correction is never locked
 * by a pending pass: a pending pass means the save opens one instead.
 */
export function useScaffoldStartRange(tz: string, opensPass: boolean): ProgramStartRange {
  const window = useProgramStore((s) => s.programStartWindow);
  const locked = useProgramStore((s) => s.programStartLocked);
  const passWindow = useProgramStore((s) => s.passStartWindow);
  const runningStart = useProgramStore((s) => s.programStartDay);
  const today = useDayKey(tz);
  return useMemo(
    () =>
      opensPass
        ? passStartRange(passWindow, today, runningStart)
        : programStartRange(window, locked, today, tz),
    [opensPass, passWindow, today, runningStart, window, locked, tz],
  );
}
