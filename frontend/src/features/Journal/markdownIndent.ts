/**
 * Nesting for the journal's lists: which lines are list items, what one level
 * of indent is in this document, and how to move items between levels.
 *
 * Only LIST lines nest -- a ``-``, ``*`` or ``+`` marker separated from its
 * content by a space or a tab, the same lines Return continues. A quote does
 * not: an indented ``>`` renders as prose, so indenting or outdenting one would
 * silently change what the writer sees.
 *
 * No maximum depth is enforced. The lower bound, level 0, always exists.
 */
import { codePointToUtf16, utf16ToCodePoint } from './codePoints';
import {
  BULLET_MARKERS,
  JOURNAL_TAB_COLUMNS,
  classifyLine,
  sourceLines,
} from './journalMarkdownLines';
import type { JournalMarkdownLine } from './journalMarkdownTypes';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';

/** The indent unit when a document does not settle on one of its own. */
export const DEFAULT_INDENT_UNIT = '  ';
/** A four-space unit, taken when every indented list line uses whole multiples of it. */
export const WIDE_INDENT_UNIT = ' '.repeat(JOURNAL_TAB_COLUMNS);
/** A tab unit, taken when every indented list line is indented with tabs only. */
export const TAB_INDENT_UNIT = '\t';

/** A list item: a bullet marker separated from its content by a space or a tab. */
export function isListLine(line: JournalMarkdownLine): boolean {
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

/** One indent replacement, in code points: ``[start, end)`` becomes ``insert``. */
interface IndentChange {
  start: number;
  end: number;
  insert: string;
}

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
): IndentChange | null {
  if (direction === 'indent') return { start: line.indentEnd, end: line.indentEnd, insert: unit };
  const outdented = outdentIndent(chars.slice(line.start, line.indentEnd).join(''), unit);
  if (outdented == null) return null;
  return { start: line.start + Array.from(outdented).length, end: line.indentEnd, insert: '' };
}

/** Where a source position lands after the changes; one inside a removed range clamps to its start. */
function remap(changes: IndentChange[], position: number): number {
  let shifted = position;
  for (const change of changes) {
    const inserted = Array.from(change.insert).length;
    if (position >= change.end) shifted += inserted - (change.end - change.start);
    else if (position > change.start) shifted -= position - change.start;
  }
  return shifted;
}

/**
 * Move the list item(s) under a UTF-16 selection one level in or out.
 *
 * Every list line the selection touches moves; prose and quote lines never do.
 * The returned selection covers the same content, shifted by what was inserted
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
  const changes = listLines(chars)
    .filter((line) => touches(line, start, end))
    .map((line) => changeFor(chars, line, direction, unit))
    .filter((change): change is IndentChange => change != null);
  if (changes.length === 0) return null;

  const next = [...chars];
  for (const change of [...changes].reverse()) {
    next.splice(change.start, change.end - change.start, ...Array.from(change.insert));
  }
  const text = next.join('');
  return {
    text,
    selection: {
      start: codePointToUtf16(text, remap(changes, start)),
      end: codePointToUtf16(text, remap(changes, end)),
    },
  };
}

/**
 * The nesting level of the list item at a UTF-16 caret -- 0 for a flush item
 * -- or null when the caret is not on a list line.
 */
export function listLevelAt(body: string, caret: number): number | null {
  const chars = Array.from(body);
  const position = utf16ToCodePoint(body, caret);
  const line = sourceLines(chars)
    .map((source) => classifyLine(chars, source))
    .find((candidate) => candidate.start <= position && position <= candidate.end);
  if (line == null || !isListLine(line)) return null;
  return Math.ceil(line.indentWidth / unitColumns(inferIndentUnit(body)));
}
