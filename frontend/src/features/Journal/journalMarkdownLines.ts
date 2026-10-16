/**
 * The journal dialect's line and block model.
 *
 * One classifier serves both consumers of the dialect -- the read-mode renderer
 * and the editor's Return handling -- so the two can never drift about what a
 * marker is. Where they legitimately differ they differ on a named field
 * (``markerFollowedBy``), not on a private regex.
 */
import type {
  CharacterFormat,
  JournalMarkdownBlock,
  JournalMarkdownLine,
  LineKind,
  MarkerFollowedBy,
  SourceLine,
} from './journalMarkdownTypes';

/**
 * The one definition of the bullet marker set.
 *
 * Both the parser and ``continueMarkdownEdit`` read this array, and the marker
 * contract test loops it, so a marker added here is exercised on both sides
 * the moment it is declared.
 */
export const BULLET_MARKERS: readonly string[] = Object.freeze(['-', '*', '+']);

/** The quote marker; a block of its own, and never a bullet. */
const QUOTE_MARKER = '>';

/** Columns a tab contributes to a measured indent width. */
export const JOURNAL_TAB_COLUMNS = 4;

const TAB = '\t';
const SPACE = ' ';

/** Split in code-point space, preserving a final empty line after a trailing LF. */
export function sourceLines(chars: string[]): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '\n') continue;
    lines.push({ start, end: index });
    start = index + 1;
  }
  lines.push({ start, end: chars.length });
  return lines;
}

/** Leading run of spaces and tabs, as a source end and a column width. */
function measureIndent(chars: string[], line: SourceLine): { indentEnd: number; width: number } {
  let indentEnd = line.start;
  let width = 0;
  while (indentEnd < line.end && (chars[indentEnd] === SPACE || chars[indentEnd] === TAB)) {
    width += chars[indentEnd] === TAB ? JOURNAL_TAB_COLUMNS : 1;
    indentEnd += 1;
  }
  return { indentEnd, width };
}

/** Classify the character after a marker. Only a space or a tab separates. */
function separatorAfter(chars: string[], index: number, end: number): MarkerFollowedBy {
  if (index >= end) return 'eol';
  if (chars[index] === SPACE) return 'space';
  if (chars[index] === TAB) return 'tab';
  return 'none';
}

/**
 * How the renderer reads a marked line.
 *
 * A quote keeps exactly the shape it has always had: a flush ``>`` followed by
 * a space, or a bare ``>`` alone on its line. Anything else that starts with
 * ``>`` -- indented, tab-separated, or glued to its text -- stays prose, so no
 * body already stored renders differently than it did. A bullet needs a literal
 * space for the same reason, while indentation is allowed because a nested list
 * is the point of the marker.
 */
function renderKind(
  marker: string | null,
  followedBy: MarkerFollowedBy,
  indentWidth: number,
): LineKind {
  if (marker === QUOTE_MARKER) {
    const separated = followedBy === 'space' || followedBy === 'eol';
    return separated && indentWidth === 0 ? 'quote' : 'plain';
  }
  if (marker != null && followedBy === 'space') return 'bullet';
  return 'plain';
}

/** The deepest ATX heading; a run of seven ``#`` is prose. */
export const MAX_HEADING_LEVEL = 6;
/** The ATX heading marker, repeated once per level. */
const HEADING_MARKER = '#';
/**
 * The longest digit run an ordered marker may have. CommonMark's own limit,
 * and well inside ``Number.MAX_SAFE_INTEGER`` so ``ordinal`` is exact.
 */
export const MAX_ORDINAL_DIGITS = 9;
/** What may close an ordered marker's digits: ``1.`` or ``1)``. */
const ORDERED_DELIMITERS: readonly string[] = Object.freeze(['.', ')']);
/** The characters a horizontal rule repeats, one kind per rule. */
const RULE_CHARACTERS: readonly string[] = Object.freeze(['-', '*', '_']);
/** The fewest repeats that make a rule. */
export const MIN_RULE_LENGTH = 3;
/** A task box: ``[``, one state character, ``]``. */
const TASK_BOX_WIDTH = 3;
const TASK_STATES: Readonly<Record<string, boolean>> = Object.freeze({
  ' ': false,
  x: true,
  X: true,
});

/** The block reading of a line beyond its lexical marker. */
interface BlockReading {
  kind: LineKind;
  contentStart: number;
  headingLevel: number | null;
  ordinal: number | null;
  taskChecked: boolean | null;
}

/** The reading of a line with no block structure; each reader overrides it. */
const PLAIN: BlockReading = Object.freeze({
  kind: 'plain',
  contentStart: 0,
  headingLevel: null,
  ordinal: null,
  taskChecked: null,
});

function isSeparator(char: string | undefined): boolean {
  return char === SPACE || char === TAB;
}

function isDigit(char: string | undefined): boolean {
  return char != null && char >= '0' && char <= '9';
}

/** End of a run of ``char`` starting at ``index`` (exclusive), bounded by ``end``. */
function runEnd(chars: string[], index: number, end: number, test: (c: string) => boolean): number {
  let cursor = index;
  while (cursor < end && test(chars[cursor]!)) cursor += 1;
  return cursor;
}

/**
 * Only three or more of ONE of ``-``, ``*``, ``_``, with whitespace around and
 * nothing else. ``- - -`` and ``* * *`` stay what they were (a bullet).
 */
function isRule(chars: string[], indentEnd: number, end: number): boolean {
  const char = chars[indentEnd];
  // A line feed (or the end of the body) is in no set below, so no read here
  // can run past ``end``.
  if (char == null || !RULE_CHARACTERS.includes(char)) return false;
  const repeatEnd = runEnd(chars, indentEnd, end, (c) => c === char);
  const trailingEnd = runEnd(chars, repeatEnd, end, (c) => isSeparator(c));
  return repeatEnd - indentEnd >= MIN_RULE_LENGTH && trailingEnd === end;
}

/** ``#``-``######`` then a space or tab: the level and the content start, or null. */
function readHeading(chars: string[], indentEnd: number, end: number): BlockReading | null {
  const hashesEnd = runEnd(chars, indentEnd, end, (c) => c === HEADING_MARKER);
  const level = hashesEnd - indentEnd;
  if (level === 0 || level > MAX_HEADING_LEVEL || !isSeparator(chars[hashesEnd])) return null;
  return { ...PLAIN, kind: 'heading', contentStart: hashesEnd + 1, headingLevel: level };
}

/** Digits, ``.`` or ``)``, then a space or tab: the ordinal and content start, or null. */
function readOrdered(chars: string[], indentEnd: number, end: number): BlockReading | null {
  const digitsEnd = runEnd(chars, indentEnd, end, isDigit);
  const digits = digitsEnd - indentEnd;
  if (digits === 0 || digits > MAX_ORDINAL_DIGITS) return null;
  const delimiter = chars[digitsEnd];
  if (delimiter == null || !ORDERED_DELIMITERS.includes(delimiter)) return null;
  if (!isSeparator(chars[digitsEnd + 1])) return null;
  const ordinal = Number(chars.slice(indentEnd, digitsEnd).join(''));
  return { ...PLAIN, kind: 'ordered', contentStart: digitsEnd + 2, ordinal };
}

/**
 * A rendered bullet whose content opens with ``[ ]``, ``[x]`` or ``[X]`` and
 * then a space or the end of the line: the checked state and content start.
 */
function readTask(chars: string[], markerEnd: number, end: number): BlockReading | null {
  // None of ``[``, a state character or ``]`` is a line feed, so a matched box
  // always ends at or before ``end``.
  const boxEnd = markerEnd + TASK_BOX_WIDTH;
  if (chars[markerEnd] !== '[' || chars[boxEnd - 1] !== ']') return null;
  const checked = TASK_STATES[chars[markerEnd + 1]!];
  if (checked == null) return null;
  if (boxEnd < end && chars[boxEnd] !== SPACE) return null;
  const contentStart = boxEnd < end ? boxEnd + 1 : boxEnd;
  return { ...PLAIN, kind: 'task', contentStart, taskChecked: checked };
}

/**
 * The line's block reading: a rule first (so ``***`` is never a ``*`` bullet),
 * then a heading, an ordered item, and finally the lexical marker's own kind --
 * a bullet becoming a task when a checkbox follows it.
 */
function readBlock(
  chars: string[],
  line: SourceLine,
  lexical: { indentEnd: number; markerEnd: number; kind: LineKind },
): BlockReading {
  const { indentEnd, markerEnd, kind } = lexical;
  if (isRule(chars, indentEnd, line.end)) return { ...PLAIN, kind: 'rule', contentStart: line.end };
  const numbered =
    readHeading(chars, indentEnd, line.end) ?? readOrdered(chars, indentEnd, line.end);
  if (numbered != null) return numbered;
  const task = kind === 'bullet' ? readTask(chars, markerEnd, line.end) : null;
  if (task != null) return task;
  return { ...PLAIN, kind, contentStart: kind === 'plain' ? line.start : markerEnd };
}

/** Read one source line's indent, opening marker, separator, and content start. */
export function classifyLine(chars: string[], line: SourceLine): JournalMarkdownLine {
  const { indentEnd, width } = measureIndent(chars, line);
  const candidate = indentEnd < line.end ? chars[indentEnd]! : null;
  const marker =
    candidate === QUOTE_MARKER || (candidate != null && BULLET_MARKERS.includes(candidate))
      ? candidate
      : null;
  const markerFollowedBy = marker == null ? 'none' : separatorAfter(chars, indentEnd + 1, line.end);
  const separated = markerFollowedBy === 'space' || markerFollowedBy === 'tab';
  const markerEnd = marker == null ? line.start : indentEnd + 1 + (separated ? 1 : 0);
  const block = readBlock(chars, line, {
    indentEnd,
    markerEnd,
    kind: renderKind(marker, markerFollowedBy, width),
  });
  return {
    start: line.start,
    contentStart: block.contentStart,
    end: line.end,
    kind: block.kind,
    marker,
    markerFollowedBy,
    markerEnd,
    indentEnd,
    indentWidth: width,
    headingLevel: block.headingLevel,
    ordinal: block.ordinal,
    taskChecked: block.taskChecked,
  };
}

/** Kinds that draw one element per line, so two in a row never merge. */
const SINGLE_LINE_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['heading', 'rule']);

/** Kinds that nest as list items, and so report their indent widths. */
const LIST_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['bullet', 'task']);

/**
 * Gather adjacent lines of the same kind so a multi-line quotation (or list)
 * is one block. A heading or a rule is always a block of its own.
 */
export function buildBlocks(chars: string[]): JournalMarkdownBlock[] {
  const blocks: JournalMarkdownBlock[] = [];
  for (const source of sourceLines(chars)) {
    const line = classifyLine(chars, source);
    const current = blocks.at(-1);
    if (current != null && current.kind === line.kind && !SINGLE_LINE_KINDS.has(line.kind)) {
      current.lines.push(line);
    } else {
      blocks.push({
        start: source.start,
        quote: line.kind === 'quote',
        kind: line.kind,
        lines: [line],
      });
    }
  }
  return blocks;
}

/**
 * Hide every block prefix while retaining it in the source-offset stream.
 *
 * The indent and marker of every structured line -- a quote's ``> ``, a
 * bullet's ``- ``, a heading's ``## ``, an ordered ``1. ``, a task's ``- [x] ``
 * and every character of a rule -- keep their source positions so an anchor
 * that crosses them still resolves; only their glyphs go.
 */
export function hideBlockPrefixes(
  formats: CharacterFormat[],
  blocks: JournalMarkdownBlock[],
): void {
  for (const block of blocks) {
    if (block.kind === 'plain') continue;
    for (const line of block.lines) {
      for (let index = line.start; index < line.contentStart; index += 1) {
        formats[index]!.visible = false;
      }
    }
  }
}

/** Distinct non-zero indent widths of the document's bullet and task lines, ascending. */
export function bulletIndentWidths(blocks: JournalMarkdownBlock[]): number[] {
  const widths = new Set<number>();
  for (const block of blocks) {
    if (!LIST_KINDS.has(block.kind)) continue;
    for (const line of block.lines) {
      if (line.indentWidth > 0) widths.add(line.indentWidth);
    }
  }
  return [...widths].sort((a, b) => a - b);
}
