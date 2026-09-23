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
  const kind = renderKind(marker, markerFollowedBy, width);
  return {
    start: line.start,
    contentStart: kind === 'plain' ? line.start : markerEnd,
    end: line.end,
    kind,
    marker,
    markerFollowedBy,
    markerEnd,
    indentEnd,
    indentWidth: width,
  };
}

/** Gather adjacent lines of the same kind so a multi-line quotation is one block. */
export function buildBlocks(chars: string[]): JournalMarkdownBlock[] {
  const blocks: JournalMarkdownBlock[] = [];
  for (const source of sourceLines(chars)) {
    const line = classifyLine(chars, source);
    const current = blocks.at(-1);
    if (current != null && current.kind === line.kind) {
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
 * The indent and marker of a quote or bullet line keep their source positions
 * so an anchor that crosses them still resolves; only their glyphs go.
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

/** Distinct non-zero indent widths of the document's bullet lines, ascending. */
export function bulletIndentWidths(blocks: JournalMarkdownBlock[]): number[] {
  const widths = new Set<number>();
  for (const block of blocks) {
    if (block.kind !== 'bullet') continue;
    for (const line of block.lines) {
      if (line.indentWidth > 0) widths.add(line.indentWidth);
    }
  }
  return [...widths].sort((a, b) => a - b);
}
