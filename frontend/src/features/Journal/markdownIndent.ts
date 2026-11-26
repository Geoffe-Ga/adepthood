/**
 * Nesting for the journal's lists: which lines are list items, what one level
 * of indent is in this document, and how to move items between levels.
 *
 * Only LIST lines nest -- a ``-``, ``*`` or ``+`` marker separated from its
 * content by a space or a tab, a task item (``- [x] done``), or a numbered item
 * (``1. one``): the same lines Return continues. A quote does not: an indented
 * ``>`` renders as prose, so indenting or outdenting one would silently change
 * what the writer sees.
 *
 * A numbered item that changes level is renumbered for where it lands, and so
 * is the run it left (``markdownOrderedList.ts``).
 *
 * An item's continuation lines (``classifyLines``) are part of it: they move
 * with it, and a caret on one moves the item.
 *
 * No maximum depth is enforced. The lower bound, level 0, always exists.
 */
import { utf16ToCodePoint } from './codePoints';
import {
  BULLET_MARKERS,
  JOURNAL_TAB_COLUMNS,
  classifyLine,
  classifyLines,
  sourceLines,
} from './journalMarkdownLines';
import type { JournalMarkdownLine } from './journalMarkdownTypes';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';
import { renumberOrderedLists } from './markdownOrderedList';
import { applySourceChanges, type SourceChange } from './sourceChanges';

/** The indent unit when a document does not settle on one of its own. */
export const DEFAULT_INDENT_UNIT = '  ';
/** A four-space unit, taken when every indented list line uses whole multiples of it. */
export const WIDE_INDENT_UNIT = ' '.repeat(JOURNAL_TAB_COLUMNS);
/** A tab unit, taken when every indented list line is indented with tabs only. */
export const TAB_INDENT_UNIT = '\t';

/**
 * A list item: a task (``- [ ] x``), a numbered item (``1. x``), or any bullet
 * marker separated from its content by a space or a tab.
 */
export function isListLine(line: JournalMarkdownLine): boolean {
  if (line.kind === 'task' || line.kind === 'ordered') return true;
  return (
    line.marker != null &&
    BULLET_MARKERS.includes(line.marker) &&
    (line.markerFollowedBy === 'space' || line.markerFollowedBy === 'tab')
  );
}

/** Every list line of a body, classified in code-point space. */
function listLines(chars: string[]): JournalMarkdownLine[] {
  return sourceLines(chars)
    .map((source) => classifyLine(chars, source))
    .filter(isListLine);
}

/**
 * This document's indent unit, read from its indented list lines.
 *
 * Tabs if every one is indented with tabs only; four spaces if every one is
 * indented with spaces in whole multiples of four; otherwise -- a mix, an odd
 * width, or no indented item at all -- two spaces.
 */
export function inferIndentUnit(body: string): string {
  const chars = Array.from(body);
  const indents = listLines(chars)
    .filter((line) => line.indentEnd > line.start)
    .map((line) => chars.slice(line.start, line.indentEnd).join(''));
  if (indents.length === 0) return DEFAULT_INDENT_UNIT;
  if (indents.every((indent) => /^\t+$/u.test(indent))) return TAB_INDENT_UNIT;
  const wide = indents.every(
    (indent) => /^ +$/u.test(indent) && indent.length % JOURNAL_TAB_COLUMNS === 0,
  );
  return wide ? WIDE_INDENT_UNIT : DEFAULT_INDENT_UNIT;
}

/** How many columns one unit spans. */
function unitColumns(unit: string): number {
  return unit === TAB_INDENT_UNIT ? JOURNAL_TAB_COLUMNS : unit.length;
}

/**
 * An indent one level shallower, or null at level 0.
 *
 * Removes from the END of the indent -- the level nearest the marker -- so a
 * mixed indent keeps its outer levels as typed: one whole unit if the indent
 * ends in one, else one trailing tab, else up to a unit's width of spaces.
 */
export function outdentIndent(indent: string, unit: string): string | null {
  if (indent === '') return null;
  if (indent.endsWith(unit)) return indent.slice(0, -unit.length);
  if (indent.endsWith(TAB_INDENT_UNIT)) return indent.slice(0, -1);
  const trailing = indent.length - indent.replace(/ +$/u, '').length;
  return indent.slice(0, indent.length - Math.min(trailing, unitColumns(unit)));
}

/** Which way a list item moves. */
export type ShiftDirection = 'indent' | 'outdent';

/**
 * Whether a selection touches a line. A collapsed caret touches its own line;
 * a range touches every line it overlaps, but NOT a line it merely reaches the
 * start of -- selecting down to the start of the next line selects none of it.
 */
function touches(line: JournalMarkdownLine, start: number, end: number): boolean {
  if (start === end) return line.start <= start && start <= line.end;
  return line.start < end && start <= line.end;
}

/** The change one list line makes, or null when it cannot move that way. */
function changeFor(
  chars: string[],
  line: JournalMarkdownLine,
  direction: ShiftDirection,
  unit: string,
): SourceChange | null {
  if (direction === 'indent') return { start: line.indentEnd, end: line.indentEnd, insert: unit };
  const outdented = outdentIndent(chars.slice(line.start, line.indentEnd).join(''), unit);
  if (outdented == null) return null;
  return { start: line.start + Array.from(outdented).length, end: line.indentEnd, insert: '' };
}

/** One list line that can move, with its line index and the indent change that moves it. */
interface ListMove {
  index: number;
  line: JournalMarkdownLine;
  change: SourceChange;
}

/** The continuation lines of the item at ``index``: the lines right after it that it owns. */
function continuationsOf(
  lines: readonly JournalMarkdownLine[],
  index: number,
): JournalMarkdownLine[] {
  const item = lines[index];
  const owned: JournalMarkdownLine[] = [];
  for (let next = index + 1; lines[next]?.owner === item; next += 1) owned.push(lines[next]!);
  return owned;
}

/** Whether the selection touches an item on its own line or on one of its continuation lines. */
function touchesItem(
  lines: readonly JournalMarkdownLine[],
  index: number,
  start: number,
  end: number,
): boolean {
  return [lines[index]!, ...continuationsOf(lines, index)].some((line) =>
    touches(line, start, end),
  );
}

/**
 * The change that carries a continuation line along with its item.
 *
 * A continuation line normally opens with its item's own indent, and then the
 * item's change is repeated at the same place in it, so the two stay on one
 * tab stop. One indented some other way is pushed in from its start, and on
 * an outdent is left where it is: it still clears the item's text column.
 */
function followItem(
  chars: string[],
  line: JournalMarkdownLine,
  move: ListMove,
  direction: ShiftDirection,
): SourceChange | null {
  const item = move.line;
  const itemIndent = chars.slice(item.start, item.indentEnd).join('');
  const shared = chars.slice(line.start, line.start + (item.indentEnd - item.start)).join('');
  if (shared === itemIndent) {
    const offset = line.start - item.start;
    return { ...move.change, start: move.change.start + offset, end: move.change.end + offset };
  }
  return direction === 'indent'
    ? { start: line.start, end: line.start, insert: move.change.insert }
    : null;
}

/**
 * Move the list item(s) under a UTF-16 selection one level in or out.
 *
 * Every list line the selection touches moves, with its continuation lines;
 * prose and quote lines never do. A numbered item is renumbered for its new level, as is the run it left, in
 * the same edit. The returned selection covers the same content, shifted by what was inserted
 * or removed before it. Null when no touched line can move -- a selection with
 * no list line, or an outdent with every touched item already at level 0 --
 * which is what lets Tab / Shift+Tab fall through to focus navigation there.
 */
export function shiftListLines(
  body: string,
  selection: MarkdownSelection,
  direction: ShiftDirection,
): MarkdownEdit | null {
  const chars = Array.from(body);
  const start = utf16ToCodePoint(body, Math.min(selection.start, selection.end));
  const end = utf16ToCodePoint(body, Math.max(selection.start, selection.end));
  const unit = inferIndentUnit(body);
  const lines = classifyLines(chars);
  const moves = lines
    .map((line, index) => ({ index, line }))
    .filter(({ index, line }) => isListLine(line) && touchesItem(lines, index, start, end))
    .map(({ index, line }) => ({ index, line, change: changeFor(chars, line, direction, unit) }))
    .filter((move): move is ListMove => move.change != null);
  if (moves.length === 0) return null;

  const changes = moves.flatMap((move) => [
    move.change,
    ...continuationsOf(lines, move.index)
      .map((line) => followItem(chars, line, move, direction))
      .filter((change): change is SourceChange => change != null),
  ]);
  const shifted = applySourceChanges(chars, changes, { start, end });
  return renumberOrderedLists(
    shifted,
    moves.map(({ index, line }) => ({ line: index, movedFrom: line.indentWidth })),
  );
}

/**
 * The nesting level of the list item at a UTF-16 caret -- 0 for a flush item
 * -- or null when the caret is not on a list line. A caret on a continuation
 * line is in the item that line belongs to.
 */
export function listLevelAt(body: string, caret: number): number | null {
  const chars = Array.from(body);
  const position = utf16ToCodePoint(body, caret);
  const line = classifyLines(chars).find(
    (candidate) => candidate.start <= position && position <= candidate.end,
  );
  const item = line?.owner ?? line;
  if (item == null || !isListLine(item)) return null;
  return Math.ceil(item.indentWidth / unitColumns(inferIndentUnit(body)));
}
