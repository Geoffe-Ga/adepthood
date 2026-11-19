/**
 * Whether an Energy Scaffolding save opens a new pass or corrects pass 1 (#3728).
 *
 * Every scaffolding save opens a pass (epic #3722, decision 6) through
 * ``POST /stages/passes`` -- except the very first one of a first cycle, which
 * has no pass behind it to keep: that save corrects pass 1's own start through
 * ``PUT /stages/program-calendar``, where a future day leaves the program "not
 * yet begun" -- and so does every save until that unbegun pass starts. The
 * PUT is refused once any pass has been opened (the cycle moves on), so the
 * split is decided here once, by the modal -- which picker window to offer --
 * and handed to the save, which follows it.
 */
import { useProgramStore } from '../../../store/useProgramStore';
import { todayInUserTZ } from '../../../utils/dateUtils';
import { useDayKey } from '../../../utils/dayRollover';
import type { Habit } from '../Habits.types';

import { isServerBackedHabit } from './serverIds';

/** The server's answers the split reads, as adopted into ``useProgramStore``. */
export interface ScaffoldPassState {
  /** Cycle 2 and later (begin-again or an opened pass has fixed pass 1). */
  programStartLocked: boolean;
  /** A pass already held for the future: saving again replaces it. */
  pendingPassStartsOn: string | null;
  /** Positive while a first pass placed in the future has not begun. */
  daysUntilStart: number;
  /** The running pass's start, ``YYYY-MM-DD`` in the account zone, or null when unknown. */
  programStartDay: string | null;
}

/**
 * ``true`` when the save opens a pass: in a later cycle, while a pass is held,
 * or once habits the server holds show an earlier save already happened.
 * Demo tiles and rows this device minted are not that evidence.
 *
 * A first pass that has not run a day is still corrected, habits or not: one
 * placed in the future that has not begun, and one that began ``today`` (the
 * account zone's day) -- the signup-day scaffold. Its start can only be moved,
 * because a pass opened on its own day would end it before it ran a single
 * day, and the pass picker therefore never offers that day: a person who
 * signed up today could not scaffold from today.
 */
export function scaffoldOpensPass(
  state: ScaffoldPassState,
  existingHabits: readonly Habit[],
  today: string,
): boolean {
  if (state.programStartLocked || state.pendingPassStartsOn !== null) return true;
  if (state.daysUntilStart > 0 || state.programStartDay === today) return false;
  return existingHabits.some((habit) => isServerBackedHabit(habit));
}

/** ``scaffoldOpensPass`` against the store as it stands now, with today in ``tz``. */
export const scaffoldOpensPassNow = (existingHabits: readonly Habit[], tz: string): boolean =>
  scaffoldOpensPass(useProgramStore.getState(), existingHabits, todayInUserTZ(tz));

/**
 * ``scaffoldOpensPass`` as a component reads it: subscribed to the store's
 * answers and to the shared day-rollover owner, so the decision the modal shows
 * follows the account's day across local midnight.
 */
export function useScaffoldOpensPass(existingHabits: readonly Habit[], tz: string): boolean {
  const programStartLocked = useProgramStore((s) => s.programStartLocked);
  const pendingPassStartsOn = useProgramStore((s) => s.pendingPassStartsOn);
  const daysUntilStart = useProgramStore((s) => s.daysUntilStart);
  const programStartDay = useProgramStore((s) => s.programStartDay);
  const today = useDayKey(tz);
  return scaffoldOpensPass(
    { programStartLocked, pendingPassStartsOn, daysUntilStart, programStartDay },
    existingHabits,
    today,
  );
}
