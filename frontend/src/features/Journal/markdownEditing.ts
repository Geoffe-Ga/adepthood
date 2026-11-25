/**
 * The editor half of the journal's Markdown dialect.
 *
 * It reads the SAME line classifier the renderer does
 * (``journalMarkdownLines.ts``), so the two cannot drift about what a marker is.
 * Where they legitimately differ they differ on one named field: the renderer
 * draws a block only for a literal-space separator, while the editor also
 * carries a tab-separated marker forward. Both divergences are measured
 * behaviours of this file at the time the classifier was introduced, and both
 * are pinned in ``__tests__/markdownEditing.test.ts``.
 *
 * Selections here are UTF-16 indices, exactly as ``TextInput`` reports them;
 * the model's source positions are code points, so the two are reconciled with
 * ``sourceToUtf16`` rather than assumed equal.
 */
import { codePointToUtf16 } from './codePoints';
import { classifyLine, sourceLines } from './journalMarkdownLines';
import type { JournalMarkdownLine, LineKind } from './journalMarkdownTypes';
import { inferIndentUnit, isListLine, outdentIndent, shiftListLines } from './markdownIndent';
import { followingOrdinal, orderedMarker, renumberOrderedLists } from './markdownOrderedList';

/** The key name a field reports for a forward delete. */
const FORWARD_DELETE_KEY = 'Delete';

export interface MarkdownEdit {
  text: string;
  /** Native TextInput offsets are UTF-16 string indices, as are these values. */
  selection?: MarkdownSelection;
}

export interface MarkdownSelection {
  start: number;
  end: number;
}

/** Whether ``next`` is exactly ``previous`` with one line feed inserted at ``index``. */
function isLineFeedInsertionAt(previous: string, next: string, index: number): boolean {
  return (
    next[index] === '\n' &&
    next.slice(0, index) === previous.slice(0, index) &&
    next.slice(index + 1) === previous.slice(index)
  );
}

/** Return the index of one newly inserted line feed, or null for any other edit. */
function insertedLineFeed(
  previous: string,
  next: string,
  previousSelection?: MarkdownSelection,
): number | null {
  if (next.length !== previous.length + 1) return null;
  if (
    previousSelection != null &&
    previousSelection.start === previousSelection.end &&
    isLineFeedInsertionAt(previous, next, previousSelection.start)
  ) {
    return previousSelection.start;
  }
  let sharedSuffix = 0;
  while (
    sharedSuffix < previous.length &&
    previous[previous.length - 1 - sharedSuffix] === next[next.length - 1 - sharedSuffix]
  ) {
    sharedSuffix += 1;
  }
  const index = next.length - 1 - sharedSuffix;
  return isLineFeedInsertionAt(previous, next, index) ? index : null;
}

/**
 * Whether a marker is separated from its content by a space or a tab.
 *
 * This is the editor's rule, and it is deliberately wider than the renderer's.
 * ``-\tfoo`` has always continued on Return, so a tab counts. A bare ``>`` or a
 * ``-no-space`` does NOT, which is the guard on the empty-marker exit path: a
 * lone ``>`` classifies as a quote with no content, and keying the exit off
 * emptiness alone would delete the writer's ``>`` instead of leaving it be.
 */
function isSeparated(line: JournalMarkdownLine): boolean {
  return line.markerFollowedBy === 'space' || line.markerFollowedBy === 'tab';
}

/** The kinds whose hidden prefix the classifier measures as ``contentStart``. */
const BLOCK_PREFIX_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['ordered', 'task', 'heading']);

/** The box a continued or stepped-out task item opens with: always unchecked. */
const UNCHECKED_BOX = '[ ]';

/** The line feeds before a UTF-16 offset: the zero-based index of its line. */
function lineIndexAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1;
}

/**
 * Where the prefix Return works from ends, or null when the line has none: a
 * numbered item's ``1. ``, a task's ``- [ ] ``, a heading's ``## ``, or a
 * separated ``-`` / ``>`` marker. Read from the classifier's own offsets, so a
 * rule (never a separated marker) and prose have nothing to carry or exit.
 */
function returnPrefixEnd(line: JournalMarkdownLine): number | null {
  if (BLOCK_PREFIX_KINDS.has(line.kind)) return line.contentStart;
  return line.marker != null && isSeparated(line) ? line.markerEnd : null;
}

/**
 * The marker (with its trailing space) an item hands to a line that follows
 * it or replaces it: a numbered item's punctuation with ``ordinal``, a task's
 * bullet with an unchecked box, or the bullet / quote marker as typed.
 */
function itemMarker(line: JournalMarkdownLine, chars: string[], ordinal: number): string {
  if (line.kind === 'ordered') return orderedMarker(chars, line, ordinal);
  const marker = line.marker ?? '';
  return line.kind === 'task' ? `${marker} ${UNCHECKED_BOX} ` : `${marker} `;
}

/** One Return on a marked line: the texts either side of it and where the line sits. */
interface ReturnPress {
  previous: string;
  next: string;
  lineStart: number;
  newlineIndex: number;
  /** The line Return was pressed on, classified over ``chars`` alone. */
  line: JournalMarkdownLine;
  chars: string[];
}

/**
 * Return on an empty item: a nested LIST item steps out one level (keeping its
 * marker, a numbered one renumbered for the level it lands on), and anything
 * else -- a level-0 item, a quote, a heading -- leaves the block.
 */
function exitEmptyItem(press: ReturnPress): MarkdownEdit {
  const { previous, next, lineStart, newlineIndex, line, chars } = press;
  const indent = chars.slice(0, line.indentEnd).join('');
  const outdented = isListLine(line) ? outdentIndent(indent, inferIndentUnit(previous)) : null;
  const prefix =
    outdented == null ? '' : `${outdented}${itemMarker(line, chars, line.ordinal ?? 0)}`;
  const caret = lineStart + prefix.length;
  const edit = {
    text: `${next.slice(0, lineStart)}${prefix}${next.slice(newlineIndex + 1)}`,
    selection: { start: caret, end: caret },
  };
  if (outdented == null) return edit;
  return renumberOrderedLists(edit, [
    { line: lineIndexAt(previous, lineStart), movedFrom: line.indentWidth },
  ]);
}

/** Return on an item with content: the next line opens with the item's marker. */
function continueItem(press: ReturnPress): MarkdownEdit {
  const { previous, next, lineStart, newlineIndex, line, chars } = press;
  const marker = itemMarker(line, chars, followingOrdinal(line.ordinal ?? 0));
  const prefix = `${chars.slice(0, line.indentEnd).join('')}${marker}`;
  const caret = newlineIndex + 1 + prefix.length;
  const edit = {
    text: `${next.slice(0, newlineIndex + 1)}${prefix}${next.slice(newlineIndex + 1)}`,
    selection: { start: caret, end: caret },
  };
  if (line.kind !== 'ordered') return edit;
  return renumberOrderedLists(edit, [
    { line: lineIndexAt(previous, lineStart) + 1, movedFrom: null },
  ]);
}

/**
 * Continue the lightweight Markdown block at the actual caret.
 *
 * React Native's TextInput remains the source of truth so selection, dictation,
 * undo, and autosave all keep working. This adds the one editor convenience a
 * plain multiline field does not provide: Return after a list item or quote
 * carries its marker forward -- a numbered item the next number, with the items
 * below it counted on, and a task an unchecked box -- Return on an empty nested
 * list item steps it out one level, and Return on any other empty marker exits
 * the block. A heading with text and a rule never continue.
 *
 * Every block is read from ``classifyLine``; nothing here matches line text.
 */
export function continueMarkdownEdit(
  previous: string,
  next: string,
  previousSelection?: MarkdownSelection,
): MarkdownEdit {
  const newlineIndex = insertedLineFeed(previous, next, previousSelection);
  if (newlineIndex == null) return { text: next };

  const lineStart = previous.lastIndexOf('\n', newlineIndex - 1) + 1;
  const chars = Array.from(previous.slice(lineStart, newlineIndex));
  const line = classifyLine(chars, { start: 0, end: chars.length });
  const prefixEnd = returnPrefixEnd(line);
  if (prefixEnd == null) return { text: next };

  const press = { previous, next, lineStart, newlineIndex, line, chars };
  if (prefixEnd === chars.length) return exitEmptyItem(press);
  return line.kind === 'heading' ? { text: next } : continueItem(press);
}

/** String-only compatibility helper for callers that do not control a caret. */
export function continueMarkdownLine(previous: string, next: string): string {
  return continueMarkdownEdit(previous, next).text;
}

/** The line whose content starts at this UTF-16 caret, if one does. */
function markedLineAtCaret(body: string, caret: number): JournalMarkdownLine | null {
  const chars = Array.from(body);
  for (const source of sourceLines(chars)) {
    const line = classifyLine(chars, source);
    if (line.contentStart === line.start) continue;
    if (codePointToUtf16(body, line.contentStart) === caret) return line;
  }
  return null;
}

/**
 * Backspace at the start of a marked line's content; null everywhere else so
 * the field handles ordinary deletion itself.
 *
 * A nested LIST item -- bulleted, numbered or task -- steps out one level,
 * keeping its marker and the caret at its content. Any other marked line -- a
 * level-0 item, a quote, a heading -- loses its
 * whole hidden prefix in one step: the prefix renders as nothing, so deleting
 * it one invisible character at a time would look like a stuck key.
 */
export function deleteBackwardEdit(
  body: string,
  selection: MarkdownSelection,
): MarkdownEdit | null {
  if (selection.start !== selection.end) return null;
  const line = markedLineAtCaret(body, selection.start);
  if (line == null) return null;
  const outdented = isListLine(line) ? shiftListLines(body, selection, 'outdent') : null;
  if (outdented != null) return outdented;
  const lineStart = codePointToUtf16(body, line.start);
  return {
    text: `${body.slice(0, lineStart)}${body.slice(selection.start)}`,
    selection: { start: lineStart, end: lineStart },
  };
}

/** Whether ``next`` is ``previous`` less exactly the one character before a collapsed caret. */
function isBackspaceAt(previous: string, next: string, selection: MarkdownSelection): boolean {
  if (selection.start !== selection.end) return false;
  const before = previous.slice(0, selection.start);
  const removed = Array.from(before).at(-1);
  if (removed == null) return false;
  return next === `${before.slice(0, -removed.length)}${previous.slice(selection.start)}`;
}

/**
 * The editor's reading of one change the field reports.
 *
 * A Backspace at a marked line's content start becomes ``deleteBackwardEdit``
 * (outdent a nested item, drop a level-0 prefix); an inserted line feed
 * becomes ``continueMarkdownEdit``. Those two are the only changes that ever
 * renumber a list. Anything else -- typing, paste, dictation,
 * a forward Delete -- is kept exactly as the field reported it. ``lastKey`` is
 * the key the field last reported, when it reports keys: a forward ``Delete``
 * can produce the same text as Backspace (``-  x``), and is never rewritten.
 */
export function reconcileBodyChange(
  previous: string,
  next: string,
  previousSelection?: MarkdownSelection,
  lastKey?: string,
): MarkdownEdit {
  if (
    previousSelection != null &&
    lastKey !== FORWARD_DELETE_KEY &&
    isBackspaceAt(previous, next, previousSelection)
  ) {
    const edit = deleteBackwardEdit(previous, previousSelection);
    if (edit != null) return edit;
  }
  return continueMarkdownEdit(previous, next, previousSelection);
}

/** One contiguous UTF-16 replacement: ``before[start, end)`` becomes ``text``. */
export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The smallest single replacement that turns ``before`` into ``after``.
 *
 * A browser applies an editor command as one native text insertion so its own
 * undo stack stays coherent, and that insertion needs exactly this: a range and
 * the text for it. The shared prefix and suffix never end or begin inside a
 * surrogate pair, so the inserted text is never a lone half of a character.
 */
export function minimalReplacement(before: string, after: string): TextReplacement {
  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}
