/**
 * Where a habit sits, and what that position makes it.
 *
 * A habit's stage IS its list position in this app: ``stageAtIndex`` maps a
 * slot to a colour on the Beige → Clear Light gradient, and both the tile
 * gradient on ``HabitsScreen`` and the row labels in ``ReorderHabitsModal``
 * paint from that derivation rather than from the stored field. This module is
 * the one place the derivation is written down for a whole list at once, so an
 * insert, a drag and the preview a writer is shown all agree about which row
 * lands on which stage.
 *
 * ## The two ``sort_order`` conventions, and which one lives here
 *
 * ``sort_order`` has two writers in this codebase and they do not agree:
 *
 * - ``saveHabitOrder`` numbers **globally**, straight down the mixed list.
 * - ``assignPartitionSlots`` / ``buildAddedHabit`` number **per partition**,
 *   restarting at zero inside the carryover rows and again inside the program
 *   rows — which is why two rows can legitimately hold the same value, and why
 *   the backend orders by ``sort_order ASC NULLS FIRST, id ASC``.
 *
 * ``stampPositionalOrder`` takes the GLOBAL convention, deliberately. A mixed
 * order is a single sequence, and a per-partition numbering cannot express one:
 * a carryover row and a program row would both claim ``0``, and the server's
 * ascending sort would break the tie by id — silently rearranging the very
 * order the person just arranged. The global numbering reproduces the array
 * exactly, which is the whole point of writing it down.
 *
 * What that does NOT do is fold the partitions together, because ``stage`` is
 * stamped from the partition-scoped display slot rather than from the global
 * index. So the two conventions are separated by FIELD rather than mixed:
 * ``sort_order`` says where the row sits in the one list, ``stage`` says which
 * rung of its own lap it sits on. That is exactly what the screens already
 * paint, so stamping it makes the stored field agree with the visible one
 * instead of introducing a third answer.
 */
import type { Habit } from '../Habits.types';
import { carryoverSlot, isCarryoverHabit, stageAtIndex } from '../HabitUtils';

/**
 * All a row has to say about itself for its lap to be known.
 *
 * Widened past ``Habit`` on purpose: the prioritise preview lays a habit that
 * does not exist yet beside the ones that do, and requiring a whole ``Habit``
 * there would mean fabricating an id, a start date and a goal list for a row
 * whose only question is which lap it counts on.
 */
export type LapMember = { is_carryover?: boolean };

/**
 * Each row's display slot: program habits count 0, 1, 2… along the cadence,
 * while carryover habits take the mirrored negative slots they are given
 * everywhere else in the app (the first one is -1).
 *
 * The list is mixed, and a carryover habit can sort ahead of every program
 * habit, so a raw row index describes neither partition. Both the date a row is
 * stamped with and the stage it is labelled with are read off this one
 * function, which is what stops a row from announcing a stage that contradicts
 * the date printed beside it.
 */
export const displaySlots = (habits: readonly LapMember[]): number[] => {
  let programIndex = 0;
  let carryoverIndex = 0;
  return habits.map((habit) => {
    if (isCarryoverHabit(habit)) {
      const slot = carryoverSlot(carryoverIndex);
      carryoverIndex += 1;
      return slot;
    }
    const slot = programIndex;
    programIndex += 1;
    return slot;
  });
};

/**
 * The stage each row of ``ordered`` would land on if that order were kept.
 *
 * Pure and total, so a prioritise preview can show the consequence of a move
 * before anything is written, and the write can then stamp the same answer
 * rather than re-deriving one of its own.
 */
export const stagePreview = (ordered: readonly LapMember[]): string[] =>
  displaySlots(ordered).map(stageAtIndex);

/**
 * ``rows`` with ``row`` placed at ``position``, clamped into range.
 *
 * Clamped rather than validated: a position is a UI-supplied number, and the
 * two out-of-range answers a caller could want — first and last — are exactly
 * what clamping gives, with no hole and no thrown error to handle in the middle
 * of a save the writer already confirmed. ``clampPosition`` is exported so a
 * caller deriving anything else from the same position (the cadence rung the
 * new row lands on, say) reads the same clamped answer this one does.
 */
export const clampPosition = (length: number, position: number): number =>
  Math.min(Math.max(Math.trunc(position), 0), length);

export const insertAt = <T>(rows: readonly T[], row: T, position: number): T[] => {
  const at = clampPosition(rows.length, position);
  return [...rows.slice(0, at), row, ...rows.slice(at)];
};

/**
 * Write each row's position into the row: ``sort_order`` from the global index,
 * ``stage`` from the partition-scoped display slot.
 *
 * Stamping ``stage`` is what the reorder path was missing. Persisting only
 * ``sort_order`` moved a habit's position without moving the stage it names, so
 * every surface reading the stored field — the settings sheet, the stats
 * calendar's tint, the goal sheet's top rule, the locked tile's "Stage X"
 * label — went on naming the rung the habit used to be on while the tile
 * gradient beside them painted the new one.
 *
 * Returns new rows; the input array and its objects are left alone, so a caller
 * can hold the pre-write snapshot for a rollback.
 */
export const stampPositionalOrder = (ordered: readonly Habit[]): Habit[] => {
  const stages = stagePreview(ordered);
  return ordered.map((habit, index) => ({
    ...habit,
    sort_order: index,
    stage: stages[index] ?? habit.stage,
  }));
};
