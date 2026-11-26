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
 * The toolbar's one List control does not toggle a kind, it CYCLES
 * ({@link cycleListStyle}): prose, bullet, number, checkbox, and prose again.
 * The three list styles stay as direct commands for the keyboard.
 *
 * A checklist item is a bullet with a box, and the two styles keep to their
 * own half of it: Checklist adds an unchecked box to a bullet (on the bullet's
 * own marker) and never unchecks an item that is already a task, while
 * Bulleted list takes the box off a task and leaves the bullet.
 *
 * AN ITEM IS ITS LINE AND ITS CONTINUATION LINES (``classifyLines``). A
 * command reached from a continuation line acts on the item it belongs to,
 * never on that line alone, and whatever the item's marker becomes, its
 * continuation lines are re-indented to sit under the new marker's text: one
 * space per character of it, or no indent at all once the item is prose.
 *
 * Blank lines inside a range are skipped (a list should not sprout empty
 * items), but a caret alone on a blank line starts a block there. Rules are
 * never touched. A list item keeps its indent when it changes list kind; a
 * quote or heading is pulled flush, because the dialect only reads them there.
 */
import { codePointToUtf16, utf16ToCodePoint } from './codePoints';
import { classifyLines } from './journalMarkdownLines';
import type { JournalMarkdownLine, LineKind } from './journalMarkdownTypes';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';

/** The line-level styles the editor offers. */
export type BlockStyle = 'bullet' | 'ordered' | 'task' | 'quote' | 'heading';

/** The three kinds of list item, in the order the List control steps through them. */
export type ListKind = 'bullet' | 'ordered' | 'task';

/** Whether each line-level style is in force across the selection. */
export type BlockStyleState = Record<BlockStyle, boolean>;

/** How deep the Heading control steps (``#``, ``##``, ``###``) before returning to prose. */
export const HEADING_CYCLE_DEPTH = 3;

/**
 * The List control's cycle: each press moves the line one step along it, and
 * the step after the last is prose.
 */
export const LIST_CYCLE: readonly ListKind[] = Object.freeze(['bullet', 'ordered', 'task']);

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
const LIST_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(LIST_CYCLE);

/** The styles that nest: a line taking one keeps the indent it has. */
const LIST_STYLES: ReadonlySet<BlockStyle> = new Set<BlockStyle>(LIST_CYCLE);

/** The kinds written with a bullet character, which survives a change between them. */
const BULLET_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['bullet', 'task']);

/** The bullet character a new bulleted or checklist item is written with. */
const DEFAULT_BULLET = '-';

/** An unchecked task box, with the space that separates it from the item's words. */
const UNCHECKED_BOX = '[ ] ';

/** What a continuation line is padded with: one space per character of its item's marker. */
const CONTINUATION_PAD = ' ';

/** One prefix replacement, in code points: ``[start, end)`` becomes ``insert``. */
interface PrefixChange {
  start: number;
  end: number;
  insert: string;
}

/** A line a command acts on, with the continuation lines that belong to it. */
interface Target {
  line: JournalMarkdownLine;
  continuations: JournalMarkdownLine[];
}

/** The body a command reads: its code points, every line, and the selection in code points. */
interface Reading {
  chars: string[];
  lines: JournalMarkdownLine[];
  start: number;
  end: number;
}

function read(body: string, selection: MarkdownSelection): Reading {
  const chars = Array.from(body);
  return {
    chars,
    lines: classifyLines(chars),
    start: utf16ToCodePoint(body, Math.min(selection.start, selection.end)),
    end: utf16ToCodePoint(body, Math.max(selection.start, selection.end)),
  };
}

function isBlank(chars: string[], line: JournalMarkdownLine): boolean {
  return chars.slice(line.start, line.end).every((char) => char === ' ' || char === '\t');
}

/** Whether a selection touches a line; a range does not touch a line it only reaches the start of. */
function touches(line: JournalMarkdownLine, start: number, end: number): boolean {
  if (start === end) return line.start <= start && start <= line.end;
  return line.start < end && start <= line.end;
}

/** Every line that is not a continuation line, with the continuation lines it owns. */
function groupItems(lines: readonly JournalMarkdownLine[]): Target[] {
  const targets: Target[] = [];
  for (const line of lines) {
    if (line.owner == null) targets.push({ line, continuations: [] });
    // A continuation line directly follows its item or a sibling, so the last target owns it.
    else targets.at(-1)!.continuations.push(line);
  }
  return targets;
}

/**
 * The items a command acts on: touched on their own line or on one of their
 * continuation lines, never a rule, and blank only under a lone caret.
 */
function targetItems({ chars, lines, start, end }: Reading): Target[] {
  return groupItems(lines)
    .filter(({ line, continuations }) =>
      [line, ...continuations].some((each) => touches(each, start, end)),
    )
    .filter(({ line }) => line.kind !== 'rule')
    .filter(({ line }) => start === end || !isBlank(chars, line));
}

/** Where the line's block prefix ends: its content start, or its indent on prose. */
function prefixEnd(line: JournalMarkdownLine): number {
  return STYLED_KINDS.has(line.kind) ? line.contentStart : line.indentEnd;
}

function hasStyle(line: JournalMarkdownLine, style: BlockStyle): boolean {
  return STYLE_KINDS[style].includes(line.kind);
}

/** The list kind a line is, or null for anything that is not a list item. */
function listKindOf(line: JournalMarkdownLine): ListKind | null {
  return LIST_CYCLE.find((kind) => hasStyle(line, kind)) ?? null;
}

/**
 * The ordinal to start a numbered run at: one past an ordered item just above
 * at the same depth, whether the line above is that item or its last
 * continuation line.
 */
function firstOrdinal(lines: readonly JournalMarkdownLine[], first: JournalMarkdownLine): number {
  const above = lines.find((line) => line.end === first.start - 1);
  const item = above?.owner ?? above;
  if (item?.kind !== 'ordered' || item.indentWidth !== first.indentWidth) return 1;
  return (item.ordinal ?? 0) + 1;
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

/**
 * The changes that carry an item's continuation lines to its new prefix.
 *
 * Each one's indent up to the item's old text column is replaced by
 * ``pad`` -- the new indent and marker in spaces, or nothing once the item is
 * prose -- and anything the writer indented beyond that column is kept.
 */
function continuationChanges(chars: string[], target: Target, pad: string): PrefixChange[] {
  const column = target.line.contentStart - target.line.start;
  return target.continuations.map((line) => {
    const beyond = chars.slice(Math.min(line.start + column, line.indentEnd), line.indentEnd);
    return { start: line.start, end: line.indentEnd, insert: `${pad}${beyond.join('')}` };
  });
}

/** The changes that give every target the style, its continuation lines under the new marker. */
function applyChanges(
  { chars, lines }: Reading,
  targets: Target[],
  style: BlockStyle,
  headingLevel: number,
): PrefixChange[] {
  let ordinal = targets.length > 0 ? firstOrdinal(lines, targets[0]!.line) : 1;
  // An item that is already a task keeps its box as written, so making a mixed
  // range a checklist never unchecks the items that were one already.
  const styled = targets.filter(({ line }) => style !== 'task' || !hasStyle(line, 'task'));
  return styled.flatMap((target) => {
    const { line } = target;
    const nests = LIST_STYLES.has(style);
    const keepsIndent = nests && (LIST_KINDS.has(line.kind) || !STYLED_KINDS.has(line.kind));
    const indent = keepsIndent ? chars.slice(line.start, line.indentEnd).join('') : '';
    const marker = markerFor(style, bulletOf(chars, line), { ordinal, headingLevel });
    ordinal += 1;
    const pad = nests ? `${indent}${CONTINUATION_PAD.repeat(Array.from(marker).length)}` : '';
    return [
      { start: line.start, end: prefixEnd(line), insert: `${indent}${marker}` },
      ...continuationChanges(chars, target, pad),
    ];
  });
}

/** The changes that turn every target back into prose, its continuation lines flush with it. */
function removeChanges(chars: string[], targets: Target[]): PrefixChange[] {
  return targets.flatMap((target) => [
    { start: target.line.start, end: target.line.contentStart, insert: '' },
    ...continuationChanges(chars, target, ''),
  ]);
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

function headingChanges(reading: Reading, targets: Target[]): PrefixChange[] {
  const allHeadings = targets.every(({ line }) => hasStyle(line, 'heading'));
  const level = allHeadings ? (targets[0]!.line.headingLevel ?? 0) + 1 : 1;
  return level > HEADING_CYCLE_DEPTH
    ? removeChanges(reading.chars, targets)
    : applyChanges(reading, targets, 'heading', level);
}

/** The changes a style's own control makes: on where any target lacks it, off where all have it. */
function toggleChanges(reading: Reading, targets: Target[], style: BlockStyle): PrefixChange[] {
  if (style === 'heading') return headingChanges(reading, targets);
  if (targets.every(({ line }) => hasStyle(line, style))) {
    return removeChanges(reading.chars, targets);
  }
  return applyChanges(reading, targets, style, 0);
}

/** The step after ``kind`` on the List control's cycle; null is prose, at either end. */
export function nextListKind(kind: ListKind | null): ListKind | null {
  const at = kind == null ? -1 : LIST_CYCLE.indexOf(kind);
  return LIST_CYCLE[at + 1] ?? null;
}

/**
 * The changes one press of the List control makes. The first target decides
 * the step, and every target takes it, so a mixed range is brought to one
 * kind and cycles together from then on. Leaving the cycle clears list items
 * only: a quote or heading caught in the range is not a list to take away.
 */
function cycleChanges(reading: Reading, targets: Target[]): PrefixChange[] {
  const next = nextListKind(listKindOf(targets[0]!.line));
  if (next != null) return applyChanges(reading, targets, next, 0);
  return removeChanges(
    reading.chars,
    targets.filter(({ line }) => listKindOf(line) != null),
  );
}

/** Run a command's changes against the body, carrying the selection through them. */
function edit(
  body: string,
  selection: MarkdownSelection,
  changesFor: (_reading: Reading, _targets: Target[]) => PrefixChange[],
): MarkdownEdit | null {
  const reading = read(body, selection);
  const { chars, start, end } = reading;
  const targets = targetItems(reading);
  if (targets.length === 0) return null;
  const changes = changesFor(reading, targets).filter(
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
  return edit(body, selection, (reading, targets) => toggleChanges(reading, targets, style));
}

/**
 * Step the lines a UTF-16 selection touches one place along the list cycle:
 * prose, bullet, number, checkbox, prose.
 *
 * Null when there is no line to act on, as for {@link toggleBlockStyle}.
 */
export function cycleListStyle(body: string, selection: MarkdownSelection): MarkdownEdit | null {
  return edit(body, selection, cycleChanges);
}

/**
 * The list kind the List control shows at a UTF-16 selection: the kind of the
 * first line it touches, which is the line the next press steps from. Null on
 * prose, a quote or a heading, and where there is no line to act on.
 */
export function listKindAt(body: string, selection: MarkdownSelection): ListKind | null {
  const first = targetItems(read(body, selection))[0];
  return first == null ? null : listKindOf(first.line);
}

/** Which line-level styles every non-blank line under a UTF-16 selection carries. */
export function blockStyleState(body: string, selection: MarkdownSelection): BlockStyleState {
  const reading = read(body, selection);
  const lines = targetItems(reading)
    .map(({ line }) => line)
    .filter((line) => !isBlank(reading.chars, line));
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
