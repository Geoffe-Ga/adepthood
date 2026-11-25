/**
 * Line-level formatting for the journal editor: bulleted and numbered lists,
 * checklists, quotes, and headings, toggled on the lines a selection touches.
 *
 * Reads lines with the SAME classifier the renderer uses
 * (``journalMarkdownLines.ts``), so a line the toolbar calls a quote is exactly
 * a line read mode draws as one. Each command behaves like a word processor's:
 *
 * - When every touched line already has the style, pressing it again turns
 *   them back into prose (a heading instead steps one level deeper, to
 *   {@link HEADING_CYCLE_DEPTH}, and then back to prose).
 * - Otherwise each touched line takes the style, replacing whatever block
 *   marker it had -- a bullet becomes a number rather than ``1. - item``.
 *
 * A checklist item is a bullet with a box, and the two controls keep to their
 * own half of it: Checklist adds an unchecked box to a bullet (on the bullet's
 * own marker) and never unchecks an item that is already a task, while
 * Bulleted list takes the box off a task and leaves the bullet.
 *
 * Blank lines inside a range are skipped (a list should not sprout empty
 * items), but a caret alone on a blank line starts a block there. Rules are
 * never touched. A list item keeps its indent when it changes list kind; a
 * quote or heading is pulled flush, because the dialect only reads them there.
 */
import { codePointToUtf16, utf16ToCodePoint } from './codePoints';
import { classifyLine, sourceLines } from './journalMarkdownLines';
import type { JournalMarkdownLine, LineKind } from './journalMarkdownTypes';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';

/** The line-level styles the toolbar offers. */
export type BlockStyle = 'bullet' | 'ordered' | 'task' | 'quote' | 'heading';

/** Whether each line-level style is in force across the selection. */
export type BlockStyleState = Record<BlockStyle, boolean>;

/** How deep the Heading control steps (``#``, ``##``, ``###``) before returning to prose. */
export const HEADING_CYCLE_DEPTH = 3;

/** The line kinds that carry a block prefix the toolbar may replace. */
const STYLED_KINDS: ReadonlySet<LineKind> = new Set<LineKind>([
  'bullet',
  'task',
  'ordered',
  'quote',
  'heading',
]);

/** The kinds that read as each style: one each, so no two controls are pressed at once. */
const STYLE_KINDS: Readonly<Record<BlockStyle, readonly LineKind[]>> = Object.freeze({
  bullet: ['bullet'],
  ordered: ['ordered'],
  task: ['task'],
  quote: ['quote'],
  heading: ['heading'],
});

/** The kinds that nest, and so keep their indent when changing list kind. */
const LIST_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['bullet', 'task', 'ordered']);

/** The styles that nest: a line taking one keeps the indent it has. */
const LIST_STYLES: ReadonlySet<BlockStyle> = new Set<BlockStyle>(['bullet', 'ordered', 'task']);

/** The kinds written with a bullet character, which survives a change between them. */
const BULLET_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['bullet', 'task']);

/** The bullet character a new bulleted or checklist item is written with. */
const DEFAULT_BULLET = '-';

/** An unchecked task box, with the space that separates it from the item's words. */
const UNCHECKED_BOX = '[ ] ';

/** One prefix replacement, in code points: ``[start, end)`` becomes ``insert``. */
interface PrefixChange {
  start: number;
  end: number;
  insert: string;
}

function isBlank(chars: string[], line: JournalMarkdownLine): boolean {
  return chars.slice(line.start, line.end).every((char) => char === ' ' || char === '\t');
}

/** Whether a selection touches a line; a range does not touch a line it only reaches the start of. */
function touches(line: JournalMarkdownLine, start: number, end: number): boolean {
  if (start === end) return line.start <= start && start <= line.end;
  return line.start < end && start <= line.end;
}

/** The lines a command acts on: touched, never a rule, and blank only under a lone caret. */
function targetLines(chars: string[], start: number, end: number): JournalMarkdownLine[] {
  return sourceLines(chars)
    .map((source) => classifyLine(chars, source))
    .filter((line) => touches(line, start, end))
    .filter((line) => line.kind !== 'rule')
    .filter((line) => start === end || !isBlank(chars, line));
}

/** Where the line's block prefix ends: its content start, or its indent on prose. */
function prefixEnd(line: JournalMarkdownLine): number {
  return STYLED_KINDS.has(line.kind) ? line.contentStart : line.indentEnd;
}

function hasStyle(line: JournalMarkdownLine, style: BlockStyle): boolean {
  return STYLE_KINDS[style].includes(line.kind);
}

/** The ordinal to start a numbered run at: one past an ordered item just above at the same depth. */
function firstOrdinal(chars: string[], first: JournalMarkdownLine): number {
  if (first.start === 0) return 1;
  const lines = sourceLines(chars).map((source) => classifyLine(chars, source));
  const above = lines.find((line) => line.end === first.start - 1);
  if (above?.kind !== 'ordered' || above.indentWidth !== first.indentWidth) return 1;
  return (above.ordinal ?? 0) + 1;
}

/** The numbering and heading depth a run of new markers is written with. */
interface MarkerContext {
  ordinal: number;
  headingLevel: number;
}

/** The bullet character a line already has, or the default for a line without one. */
function bulletOf(chars: string[], line: JournalMarkdownLine): string {
  return BULLET_KINDS.has(line.kind) ? (chars[line.indentEnd] ?? DEFAULT_BULLET) : DEFAULT_BULLET;
}

/** The marker (with its trailing space) a line takes for a style. */
function markerFor(style: BlockStyle, bullet: string, context: MarkerContext): string {
  if (style === 'bullet') return `${bullet} `;
  if (style === 'task') return `${bullet} ${UNCHECKED_BOX}`;
  if (style === 'ordered') return `${String(context.ordinal)}. `;
  if (style === 'quote') return '> ';
  return `${'#'.repeat(context.headingLevel)} `;
}

/** The changes that give every target line the style. */
function applyChanges(
  chars: string[],
  lines: JournalMarkdownLine[],
  style: BlockStyle,
  headingLevel: number,
): PrefixChange[] {
  let ordinal = lines.length > 0 ? firstOrdinal(chars, lines[0]!) : 1;
  // An item that is already a task keeps its box as written, so making a mixed
  // range a checklist never unchecks the items that were one already.
  const styled = lines.filter((line) => style !== 'task' || !hasStyle(line, 'task'));
  return styled.map((line) => {
    const keepsIndent =
      LIST_STYLES.has(style) && (LIST_KINDS.has(line.kind) || !STYLED_KINDS.has(line.kind));
    const indent = keepsIndent ? chars.slice(line.start, line.indentEnd).join('') : '';
    const marker = markerFor(style, bulletOf(chars, line), { ordinal, headingLevel });
    ordinal += 1;
    return { start: line.start, end: prefixEnd(line), insert: `${indent}${marker}` };
  });
}

/** The changes that turn every target line back into prose. */
function removeChanges(lines: JournalMarkdownLine[]): PrefixChange[] {
  return lines.map((line) => ({ start: line.start, end: line.contentStart, insert: '' }));
}

/**
 * Where a source position lands after the changes. A lone caret inside (or at
 * either edge of) a replaced prefix lands at the new content start; a range
 * edge at a line start stays before the new marker, so the range still covers
 * the whole line.
 */
function remap(changes: PrefixChange[], position: number, caret: boolean): number {
  let shifted = position;
  for (const change of changes) {
    const inserted = Array.from(change.insert).length;
    const removed = change.end - change.start;
    const inPrefix = caret
      ? position >= change.start && position <= change.end
      : position > change.start && position < change.end;
    if (inPrefix) shifted += change.start + inserted - position;
    else if (position >= change.end && position > change.start) shifted += inserted - removed;
  }
  return shifted;
}

function headingChanges(chars: string[], lines: JournalMarkdownLine[]): PrefixChange[] {
  const allHeadings = lines.every((line) => hasStyle(line, 'heading'));
  const level = allHeadings ? (lines[0]!.headingLevel ?? 0) + 1 : 1;
  return level > HEADING_CYCLE_DEPTH
    ? removeChanges(lines)
    : applyChanges(chars, lines, 'heading', level);
}

/**
 * Toggle a line-level style on the lines a UTF-16 selection touches.
 *
 * Null when there is no line to act on (only rules, or only blank lines in a
 * range) or nothing would change.
 */
export function toggleBlockStyle(
  body: string,
  selection: MarkdownSelection,
  style: BlockStyle,
): MarkdownEdit | null {
  const chars = Array.from(body);
  const start = utf16ToCodePoint(body, Math.min(selection.start, selection.end));
  const end = utf16ToCodePoint(body, Math.max(selection.start, selection.end));
  const lines = targetLines(chars, start, end);
  if (lines.length === 0) return null;

  let changes: PrefixChange[];
  if (style === 'heading') changes = headingChanges(chars, lines);
  else if (lines.every((line) => hasStyle(line, style))) changes = removeChanges(lines);
  else changes = applyChanges(chars, lines, style, 0);
  changes = changes.filter(
    (change) => chars.slice(change.start, change.end).join('') !== change.insert,
  );
  if (changes.length === 0) return null;

  const next = [...chars];
  for (const change of [...changes].reverse()) {
    next.splice(change.start, change.end - change.start, ...Array.from(change.insert));
  }
  const text = next.join('');
  const caret = start === end;
  return {
    text,
    selection: {
      start: codePointToUtf16(text, remap(changes, start, caret)),
      end: codePointToUtf16(text, remap(changes, end, caret)),
    },
  };
}

/** Which line-level styles every non-blank line under a UTF-16 selection carries. */
export function blockStyleState(body: string, selection: MarkdownSelection): BlockStyleState {
  const chars = Array.from(body);
  const start = utf16ToCodePoint(body, Math.min(selection.start, selection.end));
  const end = utf16ToCodePoint(body, Math.max(selection.start, selection.end));
  const lines = targetLines(chars, start, end).filter((line) => !isBlank(chars, line));
  const every = (style: BlockStyle) =>
    lines.length > 0 && lines.every((line) => hasStyle(line, style));
  return {
    bullet: every('bullet'),
    ordered: every('ordered'),
    task: every('task'),
    quote: every('quote'),
    heading: every('heading'),
  };
}
