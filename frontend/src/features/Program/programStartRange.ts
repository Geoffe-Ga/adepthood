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
  return { minDay, maxDay: window?.latest ?? today, today, locked };
}

/**
 * The range a scaffolding save may open a new pass in (#3728): the served
 * ``pass_start_window``, in any cycle -- opening a pass is never locked. With
 * none served it is today alone, the one day that is neither before the running
 * pass nor past the ceiling, so the client offers nothing the server refuses.
 */
export function passStartRange(
  window: ProgramStartWindow | null,
  today: string,
): ProgramStartRange {
  return {
    minDay: window?.earliest ?? today,
    maxDay: window?.latest ?? today,
    today,
    locked: false,
  };
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
  const today = useDayKey(tz);
  return useMemo(() => programStartRange(window, locked, today, tz), [window, locked, today, tz]);
}

/**
 * The range the Energy Scaffolding picker offers (#3728): the pass window when
 * the save opens a new pass, the program window when it is the first save of a
 * first cycle and so corrects pass 1 itself.
 */
export function useScaffoldStartRange(tz: string, opensPass: boolean): ProgramStartRange {
  const programRange = useProgramStartRange(tz);
  const passWindow = useProgramStore((s) => s.passStartWindow);
  return useMemo(
    () => (opensPass ? passStartRange(passWindow, programRange.today) : programRange),
    [opensPass, passWindow, programRange],
  );
}
