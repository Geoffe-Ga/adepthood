/**
 * Move a pending pass's day from Settings and the Reorder modal (#3747).
 *
 * While a next pass is held for the future, the start-date screens offer its
 * day -- not a correction of the running pass, which the server's PUT would
 * drop it on. The picker is the scaffold picker's pass window with the same
 * floor rule (``passStartRange``), and the save is ``POST /stages/passes``
 * (``commitPassStart``): a later day reschedules the pending pass, today or an
 * earlier day starts it now. Nothing here touches a habit row, so the running
 * pass's rows are never re-laid.
 */
import { useCallback, useState } from 'react';

import { useProgramStore } from '../../store/useProgramStore';

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
  | Exclude<ProgramStartOutcome, { kind: 'saved' }>;

export interface PendingPassPick {
  /** The day the pending pass is held for, or null when none is pending. */
  held: string | null;
  /** The day shown: the person's pick, else the held day inside the window. */
  day: string;
  /** The pass window, never offering the running pass's own start. */
  range: ProgramStartRange;
  /** What saving will do, said before the save. */
  sentence: string;
  /** Whether saving would send anything. */
  changed: boolean;
  pick: (_day: string) => void;
  /** Drop the pick: the picker goes back to the held day. */
  reset: () => void;
  /** Send the pick. A refusal or a dropped connection puts the held day back. */
  commit: () => Promise<PendingPassOutcome>;
}

export function usePendingPassPick(tz: string): PendingPassPick {
  const held = useProgramStore((s) => s.pendingPassStartsOn);
  const range = useScaffoldStartRange(tz, true);
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? scaffoldOpeningDay(held, range);
  const changed = held !== null && day !== held;
  const reset = useCallback(() => setPicked(null), []);
  const commit = useCallback(async (): Promise<PendingPassOutcome> => {
    if (held === null || !changed) return { kind: 'unchanged' };
    const outcome = await commitPassStart(day, { tz });
    setPicked(null);
    if (outcome.kind === 'saved')
      return { kind: 'saved', message: pendingPassSavedCopy(day, range.today) };
    if (outcome.kind === 'unsaved')
      return { kind: 'unsaved', message: pendingPassNotSavedCopy(held) };
    return outcome;
  }, [held, changed, day, tz, range.today]);
  return {
    held,
    day,
    range,
    sentence: held === null ? '' : pendingPassSentence(day, held, range.today),
    changed,
    pick: setPicked,
    reset,
    commit,
  };
}
