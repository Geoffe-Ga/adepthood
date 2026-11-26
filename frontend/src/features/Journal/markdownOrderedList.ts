/**
 * Keeping a numbered list's numbers honest.
 *
 * A numbered item's ordinal is text the writer typed, so nothing here runs on
 * an arbitrary edit: paste, dictation and deletion store exactly what they
 * produce. Numbers are rewritten only when the editor itself adds or moves a
 * numbered item -- Return, Tab, Shift+Tab, Backspace at an item's content start
 * -- and then only for the items that step affects:
 *
 * - the items FOLLOWING the new or moved one at its level count on from it;
 * - a moved item takes its number from the numbered item above it at its new
 *   level, or ``1`` when there is none;
 * - the run a moved item left closes the gap, counting on from the numbered
 *   item still above it.
 *
 * A run is the contiguous same-indent stretch of one list: lines indented
 * deeper, and an item's continuation lines (``classifyLines``), belong to the
 * item above them and are stepped over, while a blank
 * line, a shallower line, or a same-indent line that is not a numbered item
 * ends it. Each item keeps its own punctuation (``1)`` stays ``)``), an item
 * above the step is never rewritten, a list is never restarted at a number
 * other than its first item's, and a number that is already right is left
 * exactly as typed (``007.``).
 */
import { utf16ToCodePoint } from './codePoints';
import { MAX_ORDINAL_DIGITS, classifyLines } from './journalMarkdownLines';
import type { JournalMarkdownLine } from './journalMarkdownTypes';
import type { MarkdownEdit } from './markdownEditing';
import { applySourceChanges, type SourceChange } from './sourceChanges';

/** The largest ordinal the dialect reads back as a numbered item. */
const MAX_ORDINAL = 10 ** MAX_ORDINAL_DIGITS - 1;
/** The ordinal a list starts at when nothing above says otherwise. */
const FIRST_ORDINAL = 1;
/** An ordered marker's delimiter and separator sit just before its content. */
const DELIMITER_AND_SEPARATOR = 2;

/** One numbered item the editor just added or moved, addressed in the edited text. */
export interface RenumberStep {
  /** Zero-based index of the item's line. */
  line: number;
  /**
   * The indent width (in columns) the item had before it changed level, or
   * null for an item that was newly inserted and so left no run behind.
   */
  movedFrom: number | null;
}

/** The ordinal after ``ordinal``, held at the largest one the dialect can read. */
export function followingOrdinal(ordinal: number): number {
  return Math.min(ordinal + 1, MAX_ORDINAL);
}

/** An ordered line's marker with another ordinal: its own punctuation, then a space. */
export function orderedMarker(
  chars: readonly string[],
  line: JournalMarkdownLine,
  ordinal: number,
): string {
  const delimiter = chars[line.contentStart - DELIMITER_AND_SEPARATOR] ?? '';
  return `${String(ordinal)}${delimiter} `;
}

/** A line with the ordinal it should carry, which starts as the one it has. */
interface Item {
  line: JournalMarkdownLine;
  ordinal: number | null;
}

type Direction = 1 | -1;

/**
 * The nearest line at ``width`` in one direction, stepping over deeper lines;
 * null when a blank or shallower line (or the body's edge) comes first.
 */
function siblingIndex(
  items: readonly Item[],
  from: number,
  width: number,
  direction: Direction,
): number | null {
  for (let index = from + direction; index >= 0 && index < items.length; index += direction) {
    const { line } = items[index]!;
    // An item's continuation line belongs to it, even one holding only its indent.
    if (line.kind === 'continuation') continue;
    if (line.indentEnd === line.end || line.indentWidth < width) return null;
    if (line.indentWidth === width) return index;
  }
  return null;
}

/** The numbered sibling of ``from`` in one direction, with its ordinal, or null. */
function numberedSibling(
  items: readonly Item[],
  from: number,
  width: number,
  direction: Direction,
): { index: number; item: Item; ordinal: number } | null {
  const index = siblingIndex(items, from, width, direction);
  const item = index == null ? undefined : items[index];
  if (index == null || item?.ordinal == null) return null;
  return { index, item, ordinal: item.ordinal };
}

/** Count the numbered items following ``from`` in its run on from its ordinal. */
function renumberAfter(items: readonly Item[], from: number): void {
  const width = items[from]!.line.indentWidth;
  let ordinal = items[from]!.ordinal ?? FIRST_ORDINAL;
  let next = numberedSibling(items, from, width, 1);
  while (next != null) {
    ordinal = followingOrdinal(ordinal);
    next.item.ordinal = ordinal;
    next = numberedSibling(items, next.index, width, 1);
  }
}

/** Close the gap in the run a moved item left at ``width``. */
function healRunLeft(items: readonly Item[], moved: number, width: number): void {
  const below = numberedSibling(items, moved, width, 1);
  if (below == null) return;
  const above = numberedSibling(items, below.index, width, -1);
  if (above != null) renumberAfter(items, above.index);
}

function applyStep(items: readonly Item[], step: RenumberStep): void {
  const item = items[step.line];
  if (item?.ordinal == null) return;
  if (step.movedFrom != null) {
    const above = numberedSibling(items, step.line, item.line.indentWidth, -1);
    item.ordinal = above == null ? FIRST_ORDINAL : followingOrdinal(above.ordinal);
  }
  renumberAfter(items, step.line);
  if (step.movedFrom != null) healRunLeft(items, step.line, step.movedFrom);
}

/** The digit replacements for every item whose ordinal changed. */
function ordinalChanges(items: readonly Item[]): SourceChange[] {
  return items
    .filter((item) => item.ordinal != null && item.ordinal !== item.line.ordinal)
    .map(({ line, ordinal }) => ({
      start: line.indentEnd,
      end: line.contentStart - DELIMITER_AND_SEPARATOR,
      insert: String(ordinal),
    }));
}

/**
 * Renumber the lists the steps touched, in ONE edit with the selection carried
 * through, so undo and the anchor path see a single change. Steps are applied
 * in order, each seeing the numbers the ones before it settled; a step on a
 * line that is not a numbered item does nothing.
 */
export function renumberOrderedLists(
  edit: MarkdownEdit,
  steps: readonly RenumberStep[],
): MarkdownEdit {
  const chars = Array.from(edit.text);
  const items: Item[] = classifyLines(chars).map((line) => ({ line, ordinal: line.ordinal }));
  for (const step of steps) applyStep(items, step);
  const changes = ordinalChanges(items);
  if (changes.length === 0) return edit;
  const caret = edit.selection ?? { start: edit.text.length, end: edit.text.length };
  const renumbered = applySourceChanges(chars, changes, {
    start: utf16ToCodePoint(edit.text, caret.start),
    end: utf16ToCodePoint(edit.text, caret.end),
  });
  return edit.selection == null ? { text: renumbered.text } : renumbered;
}
