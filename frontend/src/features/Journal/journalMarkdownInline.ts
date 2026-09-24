/**
 * The dialect's inline emphasis, applied without consuming the source.
 *
 * The dialect is deliberately not CommonMark: a single ``*`` is bold, ``__`` is
 * bold, and ``_`` alone is italic -- a shape three existing suites and one
 * browser journey pin. Underline is spelled ``<u>x</u>`` (the owner's ruling on
 * #2889): the HTML tag Obsidian also renders as underline, where the earlier
 * ``==x==`` spelling would render as a highlight. ``==x==`` is now plain prose.
 */
import type {
  CharacterFormat,
  InlineSpan,
  InlineStyle,
  JournalMarkdownBlock,
  JournalMarkdownLine,
} from './journalMarkdownTypes';

/** An opening and a closing delimiter, as the writer types them. */
export interface InlineDelimiterPair {
  readonly open: string;
  readonly close: string;
}

/**
 * The ONE spelling of underline. The parser's tag pass and every editor action
 * that emits underline (Cmd+U, the toolbar) read this constant, so the dialect
 * cannot be spelled two ways.
 */
export const UNDERLINE_DELIMITER: InlineDelimiterPair = Object.freeze({
  open: '<u>',
  close: '</u>',
});

/**
 * The delimiter pair each editor action wraps a selection in.
 *
 * Bold and italic each have more than one parsed spelling (``*``, ``**`` and
 * ``__`` are all bold); this is the one the editor EMITS, and every entry is
 * pinned to parse as its own style.
 */
export const INLINE_DELIMITERS: Readonly<Record<InlineStyle, InlineDelimiterPair>> = Object.freeze({
  bold: Object.freeze({ open: '**', close: '**' }),
  italic: Object.freeze({ open: '_', close: '_' }),
  underline: UNDERLINE_DELIMITER,
});

/** The symmetric inline delimiters, each repeated to a width. */
type InlineMarker = '*' | '_';

/** True when a marker is escaped by an odd run of immediately preceding slashes. */
function isEscaped(chars: string[], index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && chars[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isWhitespace(char: string | undefined): boolean {
  return char == null || /\s/u.test(char);
}

/** A letter or a digit: the characters an underscore may not touch to be italic. */
export function isWordChar(char: string | undefined): boolean {
  return char != null && /[\p{L}\p{N}]/u.test(char);
}

/** Underscores inside a word are prose (`snake_case`), not emphasis markers. */
function hasWordBoundary(chars: string[], index: number, width: number, opening: boolean): boolean {
  if (chars[index] !== '_') return true;
  const outside = opening ? chars[index - 1] : chars[index + width];
  return !isWordChar(outside);
}

function isMarkerRun(chars: string[], index: number, marker: string, width: number): boolean {
  for (let offset = 0; offset < width; offset += 1) {
    if (chars[index + offset] !== marker) return false;
  }
  return chars[index - 1] !== marker && chars[index + width] !== marker;
}

/** Find the next syntactically usable closing marker on this source line. */
function findClosingMarker(
  chars: string[],
  start: number,
  end: number,
  marker: string,
  width: number,
): number | null {
  for (let index = start; index + width <= end; index += 1) {
    if (!isMarkerRun(chars, index, marker, width) || isEscaped(chars, index)) continue;
    if (isWhitespace(chars[index - 1])) continue;
    if (!hasWordBoundary(chars, index, width, false)) continue;
    return index;
  }
  return null;
}

/** A marker can open only when it is whole, unescaped, and touches content. */
function isOpeningMarker(
  chars: string[],
  index: number,
  marker: InlineMarker,
  width: number,
): boolean {
  return (
    isMarkerRun(chars, index, marker, width) &&
    !isEscaped(chars, index) &&
    !isWhitespace(chars[index + width]) &&
    hasWordBoundary(chars, index, width, true)
  );
}

/** True when ``text`` is spelled out in ``chars`` starting at ``index``. */
function spellsAt(chars: string[], index: number, text: string): boolean {
  return Array.from(text).every((char, offset) => chars[index + offset] === char);
}

/** Hide a matched pair's delimiters, style its content, and record the span. */
function markPair(
  formats: CharacterFormat[],
  span: InlineSpan,
  openLength: number,
  closeLength: number,
  spans: InlineSpan[],
): void {
  const closeStart = span.end - closeLength;
  for (let index = span.start; index < span.start + openLength; index += 1) {
    formats[index]!.visible = false;
  }
  for (let index = closeStart; index < span.end; index += 1) formats[index]!.visible = false;
  for (let index = span.start + openLength; index < closeStart; index += 1) {
    formats[index]![span.style] = true;
  }
  spans.push(span);
}

/**
 * Apply one delimiter width without consuming or changing the stored source.
 *
 * Every pair it matches is also recorded in ``spans``: the hidden flag alone
 * loses which delimiter belongs to which span, and the caret geometry needs
 * exactly that.
 */
function applyDelimitedStyle(
  chars: string[],
  formats: CharacterFormat[],
  line: JournalMarkdownLine,
  marker: InlineMarker,
  width: number,
  style: InlineStyle,
  spans: InlineSpan[],
): void {
  let index = line.contentStart;
  while (index + width < line.end) {
    if (!isOpeningMarker(chars, index, marker, width)) {
      index += 1;
      continue;
    }
    const close = findClosingMarker(chars, index + width + 1, line.end, marker, width);
    if (close == null) {
      index += width;
      continue;
    }
    markPair(formats, { start: index, end: close + width, style }, width, width, spans);
    index = close + width;
  }
}

/** The first usable closing tag in ``[start, end)``, or null. */
function findClosingTag(chars: string[], start: number, end: number, close: string): number | null {
  const closeLength = Array.from(close).length;
  for (let index = start; index + closeLength <= end; index += 1) {
    if (!spellsAt(chars, index, close) || isEscaped(chars, index)) continue;
    if (isWhitespace(chars[index - 1])) continue;
    return index;
  }
  return null;
}

/**
 * Apply an asymmetric tag pair (``<u>…</u>``) under the same guards the
 * symmetric passes use: unescaped, opener touching content, closer not preceded
 * by whitespace, at least one content character, and never across a line.
 */
function applyTagStyle(
  chars: string[],
  formats: CharacterFormat[],
  line: JournalMarkdownLine,
  pair: InlineDelimiterPair,
  style: InlineStyle,
  spans: InlineSpan[],
): void {
  const openLength = Array.from(pair.open).length;
  const closeLength = Array.from(pair.close).length;
  let index = line.contentStart;
  while (index + openLength < line.end) {
    const opens =
      spellsAt(chars, index, pair.open) &&
      !isEscaped(chars, index) &&
      !isWhitespace(chars[index + openLength]);
    const close = opens
      ? findClosingTag(chars, index + openLength + 1, line.end, pair.close)
      : null;
    if (close == null) {
      index += 1;
      continue;
    }
    markPair(
      formats,
      { start: index, end: close + closeLength, style },
      openLength,
      closeLength,
      spans,
    );
    index = close + closeLength;
  }
}

/**
 * The dialect's symmetric delimiters, in the order they are applied.
 *
 * Each pass is independent, which is what lets ``*_<u>all</u>_*`` compose.
 */
const INLINE_PASSES: readonly (readonly [InlineMarker, number, InlineStyle])[] = Object.freeze([
  ['*', 2, 'bold'],
  ['*', 1, 'bold'],
  ['_', 2, 'bold'],
  ['_', 1, 'italic'],
] as const);

/** The asymmetric tag pairs, applied after the symmetric passes. */
const TAG_PASSES: readonly (readonly [InlineDelimiterPair, InlineStyle])[] = Object.freeze([
  [UNDERLINE_DELIMITER, 'underline'],
] as const);

/**
 * Apply inline styles independently so `*_both_*` composes naturally, and hand
 * back the delimiter pairs that were matched.
 */
export function applyInlineFormatting(
  chars: string[],
  formats: CharacterFormat[],
  blocks: JournalMarkdownBlock[],
): InlineSpan[] {
  const spans: InlineSpan[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const [marker, width, style] of INLINE_PASSES) {
        applyDelimitedStyle(chars, formats, line, marker, width, style, spans);
      }
      for (const [pair, style] of TAG_PASSES)
        applyTagStyle(chars, formats, line, pair, style, spans);
    }
  }
  return spans;
}
