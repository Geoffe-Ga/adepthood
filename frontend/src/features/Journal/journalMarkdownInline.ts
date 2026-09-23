/**
 * The dialect's inline emphasis, applied without consuming the source.
 *
 * The dialect is deliberately not CommonMark: a single ``*`` is bold, ``__`` is
 * bold, and ``_`` alone is italic -- a shape three existing suites and one
 * browser journey pin. Underline is therefore spelled ``==x==``, a delimiter
 * measured to parse as plain text today, rather than by reassigning ``__``.
 */
import type {
  CharacterFormat,
  InlineSpan,
  InlineStyle,
  JournalMarkdownBlock,
  JournalMarkdownLine,
} from './journalMarkdownTypes';

/** The inline delimiters, each with its width and the style it carries. */
type InlineMarker = '*' | '_' | '=';

/** True when a marker is escaped by an odd run of immediately preceding slashes. */
function isEscaped(chars: string[], index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && chars[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isWhitespace(char: string | undefined): boolean {
  return char == null || /\s/u.test(char);
}

/** Underscores inside a word are prose (`snake_case`), not emphasis markers. */
function hasWordBoundary(chars: string[], index: number, width: number, opening: boolean): boolean {
  if (chars[index] !== '_') return true;
  const outside = opening ? chars[index - 1] : chars[index + width];
  return outside == null || !/[\p{L}\p{N}]/u.test(outside);
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
    for (let markerIndex = 0; markerIndex < width; markerIndex += 1) {
      formats[index + markerIndex]!.visible = false;
      formats[close + markerIndex]!.visible = false;
    }
    for (let contentIndex = index + width; contentIndex < close; contentIndex += 1) {
      formats[contentIndex]![style] = true;
    }
    spans.push({ start: index, end: close + width, style });
    index = close + width;
  }
}

/**
 * The dialect's delimiters, in the order they are applied.
 *
 * Each pass is independent, which is what lets ``*_==all==_*`` compose. The
 * underline entry is the single place the delimiter is spelled: changing it is
 * one character here plus the journey description.
 */
const INLINE_PASSES: readonly (readonly [InlineMarker, number, InlineStyle])[] = Object.freeze([
  ['*', 2, 'bold'],
  ['*', 1, 'bold'],
  ['_', 2, 'bold'],
  ['_', 1, 'italic'],
  ['=', 2, 'underline'],
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
    }
  }
  return spans;
}
