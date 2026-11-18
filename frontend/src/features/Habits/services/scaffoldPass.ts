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
}

/**
 * ``true`` when the save opens a pass: in a later cycle, while a pass is held,
 * or once habits the server holds show an earlier save already happened.
 * Demo tiles and rows this device minted are not that evidence.
 *
 * A first pass placed in the future that has not begun is still corrected,
 * habits or not: its start can only be moved, because a pass opened on its
 * own day -- the day the picker would offer first -- would end it before it
 * ran a single day.
 */
export function scaffoldOpensPass(
  state: ScaffoldPassState,
  existingHabits: readonly Habit[],
): boolean {
  if (state.programStartLocked || state.pendingPassStartsOn !== null) return true;
  if (state.daysUntilStart > 0) return false;
  return existingHabits.some((habit) => isServerBackedHabit(habit));
}

/** ``scaffoldOpensPass`` against the store as it stands now. */
export const scaffoldOpensPassNow = (existingHabits: readonly Habit[]): boolean =>
  scaffoldOpensPass(useProgramStore.getState(), existingHabits);
