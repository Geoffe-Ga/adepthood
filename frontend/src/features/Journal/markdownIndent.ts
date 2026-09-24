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
import {
  BULLET_MARKERS,
  JOURNAL_TAB_COLUMNS,
  classifyLine,
  sourceLines,
} from './journalMarkdownLines';
import type { JournalMarkdownLine } from './journalMarkdownTypes';

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
