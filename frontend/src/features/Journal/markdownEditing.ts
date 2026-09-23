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
import type { JournalMarkdownLine } from './journalMarkdownTypes';

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

/**
 * Continue the lightweight Markdown block at the actual caret.
 *
 * React Native's TextInput remains the source of truth so selection, dictation,
 * undo, and autosave all keep working. This adds the one editor convenience a
 * plain multiline field does not provide: Return after a list item or quote
 * carries its marker forward, while Return on an empty marker exits the block.
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
  if (line.marker == null || !isSeparated(line)) return { text: next };

  const content = chars.slice(line.markerEnd).join('');
  if (content.length === 0) {
    const text = `${next.slice(0, lineStart)}${next.slice(newlineIndex + 1)}`;
    return { text, selection: { start: lineStart, end: lineStart } };
  }

  const prefix = `${chars.slice(0, line.indentEnd).join('')}${line.marker} `;
  const caret = newlineIndex + 1 + prefix.length;
  return {
    text: `${next.slice(0, newlineIndex + 1)}${prefix}${next.slice(newlineIndex + 1)}`,
    selection: { start: caret, end: caret },
  };
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
 * Backspace at the start of a marked line's content, removing the whole hidden
 * prefix in one step; null everywhere else so the field handles ordinary
 * deletion itself.
 *
 * The prefix renders as nothing, so deleting it one invisible character at a
 * time would look like a stuck key. Removing it atomically turns the line back
 * into the prose it renders as. Outdenting a nested item one level instead of
 * exiting is a refinement the Tab/indent work owns.
 */
export function deleteBackwardEdit(
  body: string,
  selection: MarkdownSelection,
): MarkdownEdit | null {
  if (selection.start !== selection.end) return null;
  const line = markedLineAtCaret(body, selection.start);
  if (line == null) return null;
  const lineStart = codePointToUtf16(body, line.start);
  return {
    text: `${body.slice(0, lineStart)}${body.slice(selection.start)}`,
    selection: { start: lineStart, end: lineStart },
  };
}
