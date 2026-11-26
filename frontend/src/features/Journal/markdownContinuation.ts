/**
 * A list item that runs over more than one line.
 *
 * Shift+Return inside a bulleted, numbered or checkbox item opens a
 * CONTINUATION LINE: a line with no marker of its own, indented with spaces to
 * the column the item's text starts at, so it sits under that text. Return on
 * one starts the next item; Backspace at its start takes it back.
 *
 * Which lines are continuation lines is not decided here: every edit below
 * reads ``classifyLines``, the same reading the renderer and the live mirror
 * draw from. The indent is real space characters in the stored body -- never a
 * tab, never a style -- because the mirror may not change a glyph's advance.
 *
 * Offsets in and out are UTF-16, as the field reports them; the classifier's
 * are code points, and the two are converted rather than assumed equal.
 */
import { codePointToUtf16, utf16ToCodePoint } from './codePoints';
import { classifyLines, isListItem } from './journalMarkdownLines';
import type { JournalMarkdownLine } from './journalMarkdownTypes';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';
import { followingOrdinal, orderedMarker, renumberOrderedLists } from './markdownOrderedList';

/** The box a new task item opens with: always unchecked. */
const UNCHECKED_BOX = '[ ]';
/** What a continuation line is padded with. A space is the one advance the marker's width is counted in. */
const CONTINUATION_PAD = ' ';

/**
 * The marker (with its trailing space) an item hands to a line that follows
 * it or replaces it: a numbered item's punctuation with ``ordinal``, a task's
 * bullet with an unchecked box, or the bullet / quote marker as typed.
 */
export function itemMarker(line: JournalMarkdownLine, chars: string[], ordinal: number): string {
  if (line.kind === 'ordered') return orderedMarker(chars, line, ordinal);
  const marker = line.marker ?? '';
  return line.kind === 'task' ? `${marker} ${UNCHECKED_BOX} ` : `${marker} `;
}

/** A line's own indent, exactly as typed. */
function indentOf(chars: string[], line: JournalMarkdownLine): string {
  return chars.slice(line.start, line.indentEnd).join('');
}

/**
 * What a continuation line of ``item`` opens with: the item's own indent as
 * typed, then one space per character of its marker (``- `` is 2, ``10. `` is
 * 4, ``- [ ] `` is 6).
 */
export function continuationIndent(chars: string[], item: JournalMarkdownLine): string {
  return `${indentOf(chars, item)}${CONTINUATION_PAD.repeat(item.contentStart - item.indentEnd)}`;
}

/** The line a UTF-16 offset is on, read in the context of the whole body. */
interface LineInBody {
  chars: string[];
  /** Zero-based index of the line. */
  index: number;
  line: JournalMarkdownLine;
  /** The offset, in code points. */
  position: number;
}

function lineAt(body: string, offset: number): LineInBody {
  const chars = Array.from(body);
  const position = utf16ToCodePoint(body, offset);
  const lines = classifyLines(chars);
  // The first line starts at 0, so some line always starts at or before the offset.
  const index = lines.filter((line) => line.start <= position).length - 1;
  return { chars, index, line: lines[index]!, position };
}

/** ``text`` with a collapsed caret at ``caret``. */
function editAt(text: string, caret: number): MarkdownEdit {
  return { text, selection: { start: caret, end: caret } };
}

/**
 * Shift+Return: the line feed the field inserted at ``newlineIndex`` opens a
 * continuation line of the item the caret is in, whether the caret was on the
 * item's own line or on one of its continuation lines.
 *
 * Null leaves the plain line feed to the field: off a list item, and inside
 * an item's indent or marker, where a break would tear the marker apart.
 */
export function softBreakEdit(
  previous: string,
  next: string,
  newlineIndex: number,
): MarkdownEdit | null {
  const { chars, line, position } = lineAt(previous, newlineIndex);
  const item = line.owner ?? (isListItem(line) ? line : null);
  if (item == null || position < line.contentStart) return null;
  const indent = continuationIndent(chars, item);
  const afterFeed = newlineIndex + 1;
  return editAt(
    `${next.slice(0, afterFeed)}${indent}${next.slice(afterFeed)}`,
    afterFeed + indent.length,
  );
}

/**
 * Return on a continuation line starts the next item of the owning item's
 * kind and indent -- the next number (the items below counted on), a new
 * bullet, a new unchecked box. Null on any other line.
 *
 * With the caret in the line's text, the item opens on a new line and takes
 * the text after the caret. With nothing before the caret but the indent --
 * an empty continuation line above all -- the line itself becomes the item,
 * so a writer who opened it by mistake is one Return from a new item and two
 * from leaving the list.
 */
export function continuationReturnEdit(
  previous: string,
  next: string,
  newlineIndex: number,
): MarkdownEdit | null {
  const { chars, index, line, position } = lineAt(previous, newlineIndex);
  const item = line.owner;
  if (item == null) return null;
  const marker = itemMarker(item, chars, followingOrdinal(item.ordinal ?? 0));
  const prefix = `${indentOf(chars, item)}${marker}`;
  const becomesItem = position <= line.indentEnd;
  const lineStart = codePointToUtf16(previous, line.start);
  const afterFeed = newlineIndex + 1;
  const edit = becomesItem
    ? editAt(
        `${previous.slice(0, lineStart)}${prefix}${previous.slice(codePointToUtf16(previous, line.indentEnd))}`,
        lineStart + prefix.length,
      )
    : editAt(
        `${next.slice(0, afterFeed)}${prefix}${next.slice(afterFeed)}`,
        afterFeed + prefix.length,
      );
  if (item.kind !== 'ordered') return edit;
  return renumberOrderedLists(edit, [{ line: becomesItem ? index : index + 1, movedFrom: null }]);
}

/**
 * Backspace at a continuation line's content start removes its line feed and
 * its whole indent in one step, joining it to the line above. The indent
 * draws as nothing, so deleting it a space at a time would look like a stuck
 * key. Null anywhere else, so the field deletes as usual.
 */
export function joinContinuationEdit(
  body: string,
  selection: MarkdownSelection,
): MarkdownEdit | null {
  if (selection.start !== selection.end) return null;
  const { line, position } = lineAt(body, selection.start);
  if (line.kind !== 'continuation' || position !== line.contentStart) return null;
  const joinAt = codePointToUtf16(body, line.start - 1);
  return editAt(`${body.slice(0, joinAt)}${body.slice(selection.start)}`, joinAt);
}
