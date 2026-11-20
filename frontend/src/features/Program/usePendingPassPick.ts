/**
 * Move a pending pass's day from Settings and the Reorder modal (#3747).
 *
 * While a next pass is held for the future, the start-date screens offer its
 * day -- not a correction of the running pass, which the server's PUT would
 * drop it on. The picker is the scaffold picker's pass window with the same
 * floor rule (``passStartRange``), and the save is ``POST /stages/passes``
 * (``commitPassStart``): a later day reschedules the pending pass, today or an
 * earlier day starts it now.
 *
 * The habits laid for the pass move with it (#3762): once the server has
 * agreed, every row starting on or after the held day moves by the same number
 * of days (``habitManager.movePendingPass``). Rows that began before the held
 * day -- the running pass's, or ones that kept their own beginning -- never
 * move. The Reorder modal writes the moved rows with its own order, so it asks
 * for the POST alone (``moveHabits: false``).
 */
import { useCallback, useState } from 'react';

import { useHabitStore } from '../../store/useHabitStore';
import { useProgramStore } from '../../store/useProgramStore';
import { habitManager, PASS_HABITS_NOT_MOVED_COPY } from '../Habits/services/habitManager';
import { isPassRow } from '../Habits/services/habitOrdering';

import { pendingPassNotSavedCopy, pendingPassSavedCopy, pendingPassSentence } from './passCopy';
import { commitPassStart, type ProgramStartOutcome } from './programAnchor';
import {
  scaffoldOpeningDay,
  useScaffoldStartRange,
  type ProgramStartRange,
} from './programStartRange';

/** What a pending-day save came to. ``unchanged`` sent nothing. */
export type PendingPassOutcome =
  | { kind: 'unchanged' }
  | { kind: 'saved'; message: string }
  | Exclude<ProgramStartOutcome, { kind: 'saved' }>
  /** The pass moved but its habits could not follow; saving again moves them (#3762). */
  | { kind: 'rows_unsaved'; message: string };

export interface PendingPassCommitOptions {
  /**
   * Move the habits laid for the pass too (the default). The Reorder modal
   * passes false: it writes the moved rows itself, with the order.
   */
  moveHabits?: boolean;
}

export interface PendingPassPick {
  /** The day the pending pass is held for, or null when none is pending. */
  held: string | null;
  /** The day shown: the person's pick, else the held day inside the window. */
  day: string;
  /** The pass window, never offering the running pass's own start. */
  range: ProgramStartRange;
  /** What saving will do, said before the save. */
  sentence: string;
  /** Whether saving would send anything: a new day, or habits still owed. */
  changed: boolean;
  /** The pass moved but its habits did not follow yet (#3762). */
  owed: boolean;
  pick: (_day: string) => void;
  /** Drop the pick: the picker goes back to the held day. */
  reset: () => void;
  /** Send the pick. A refusal or a dropped connection puts the held day back. */
  commit: (_options?: PendingPassCommitOptions) => Promise<PendingPassOutcome>;
}

/** A pass move whose habits are still to follow: from the day they were laid for. */
interface OwedRows {
  from: string;
  to: string;
}

/** Whether any habit row was laid for a pass held for ``held`` (#3762). */
const usePassHasHabits = (held: string | null, tz: string): boolean =>
  useHabitStore((s) => held !== null && s.habits.some((habit) => isPassRow(habit, held, tz)));

type SetOwed = (_owed: OwedRows | null) => void;

/** Send the owed rows again, without moving the pass a second time. */
async function retryOwedRows(
  owed: OwedRows | null,
  context: { today: string; tz: string; moveHabits: boolean; setOwed: SetOwed },
): Promise<PendingPassOutcome> {
  if (owed === null || !context.moveHabits) return { kind: 'unchanged' };
  if (!(await habitManager.movePassHabits(owed.from, owed.to, context.tz)))
    return { kind: 'rows_unsaved', message: PASS_HABITS_NOT_MOVED_COPY };
  context.setOwed(null);
  return { kind: 'saved', message: pendingPassSavedCopy(owed.to, context.today, true) };
}

interface MoveInput {
  /** The day the pass's rows are laid for. */
  from: string;
  /** The day the pass was held for when the move was sent. */
  held: string;
  day: string;
  tz: string;
  today: string;
  moveHabits: boolean;
  withHabits: boolean;
  setOwed: SetOwed;
}

/** Send the move -- with its habits, unless the caller writes them -- and say what came of it. */
async function sendMove(input: MoveInput): Promise<PendingPassOutcome> {
  const { from, held, day, tz, today, setOwed } = input;
  const outcome = input.moveHabits
    ? await habitManager.movePendingPass(from, day, tz)
    : await commitPassStart(day, { tz });
  switch (outcome.kind) {
    case 'saved':
      setOwed(null);
      return { kind: 'saved', message: pendingPassSavedCopy(day, today, input.withHabits) };
    case 'rows_unsaved':
      setOwed({ from, to: day });
      return outcome;
    case 'unsaved':
      return { kind: 'unsaved', message: pendingPassNotSavedCopy(held) };
    default:
      return outcome;
  }
}

export function usePendingPassPick(tz: string): PendingPassPick {
  const held = useProgramStore((s) => s.pendingPassStartsOn);
  const range = useScaffoldStartRange(tz, true);
  const withHabits = usePassHasHabits(held, tz);
  const [picked, setPicked] = useState<string | null>(null);
  const [owed, setOwed] = useState<OwedRows | null>(null);
  const day = picked ?? scaffoldOpeningDay(held, range);
  const moved = held !== null && day !== held;
  const reset = useCallback(() => setPicked(null), []);
  const commit = useCallback(
    async ({ moveHabits = true }: PendingPassCommitOptions = {}): Promise<PendingPassOutcome> => {
      const context = { today: range.today, tz, moveHabits, setOwed };
      if (held === null || day === held) return retryOwedRows(owed, context);
      // Rows still owed to an earlier move were laid for that move's first day.
      const from = owed?.from ?? held;
      const outcome = await sendMove({ ...context, from, held, day, withHabits });
      setPicked(null);
      return outcome;
    },
    [held, owed, day, tz, range.today, withHabits],
  );
  return {
    held,
    day,
    range,
    sentence: held === null ? '' : pendingPassSentence(day, held, range.today, withHabits),
    changed: moved || owed !== null,
    owed: owed !== null,
    pick: setPicked,
    reset,
    commit,
  };
}
