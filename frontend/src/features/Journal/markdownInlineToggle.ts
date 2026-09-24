/**
 * Bold / italic / underline as editor actions over the journal's source.
 *
 * Every action rewrites the canonical source and nothing else: it inserts or
 * removes the delimiters the parser reads (``INLINE_DELIMITERS``), and it
 * proves the result by re-parsing it. The postcondition is the contract, not a
 * courtesy: a wrap the dialect would not read -- a closing delimiter escaped by
 * a backslash, a mid-word underscore -- is refused (``null``) instead of being
 * written as corrupt, half-styled source.
 *
 * Selections are UTF-16, as a ``TextInput`` reports them, and are converted to
 * source positions only through the facade's ``utf16ToSource`` /
 * ``sourceToUtf16`` -- the one conversion the whole journal shares.
 */
import {
  INLINE_DELIMITERS,
  isWordChar,
  parseJournalMarkdown,
  sourceToUtf16,
  utf16ToSource,
  type InlineSpan,
  type InlineStyle,
  type JournalMarkdownDocument,
} from './journalMarkdown';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';

/** One replacement in source positions: drop ``remove`` points at ``at``, then insert. */
interface SourceEdit {
  at: number;
  remove: number;
  insert: string;
}

/** A half-open source range. */
interface SourceRange {
  start: number;
  end: number;
}

function isBlank(char: string | undefined): boolean {
  return char == null || /\s/u.test(char);
}

function sourceRange(body: string, selection: MarkdownSelection): SourceRange {
  const start = utf16ToSource(body, Math.min(selection.start, selection.end));
  const end = utf16ToSource(body, Math.max(selection.start, selection.end));
  return { start, end };
}

/** Apply non-overlapping edits right to left, removal before insertion at a tie. */
function applyEdits(chars: string[], edits: SourceEdit[]): string {
  const next = [...chars];
  const ordered = [...edits].sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const edit of ordered) next.splice(edit.at, edit.remove, ...Array.from(edit.insert));
  return next.join('');
}

/** Where a surviving source character lands once ``edits`` are applied. */
function shiftIndex(edits: SourceEdit[], index: number): number {
  let shifted = index;
  for (const edit of edits) {
    if (edit.at + edit.remove <= index) shifted += Array.from(edit.insert).length - edit.remove;
  }
  return shifted;
}

/** The recorded spans of one style whose content holds a position. */
function styleSpansAt(
  document: JournalMarkdownDocument,
  index: number,
  style: InlineStyle,
): InlineSpan[] {
  return document.inlineSpans.filter(
    (span) => span.style === style && span.contentStart <= index && index <= span.contentEnd,
  );
}

/** Both delimiter runs of a span, as removals. */
function unwrapSpan(span: InlineSpan): SourceEdit[] {
  return [
    { at: span.start, remove: span.contentStart - span.start, insert: '' },
    { at: span.contentEnd, remove: span.end - span.contentEnd, insert: '' },
  ];
}

/**
 * One line's slice of a selection, clamped to the line's content, trimmed of
 * edge whitespace, and -- for italic, whose ``_`` the dialect ignores inside a
 * word -- snapped outward to whole words. Empty slices are dropped.
 */
function lineSegments(
  document: JournalMarkdownDocument,
  range: SourceRange,
  style: InlineStyle,
): SourceRange[] {
  const segments: SourceRange[] = [];
  for (const line of document.blocks.flatMap((block) => block.lines)) {
    const clamped = {
      start: Math.max(range.start, line.contentStart),
      end: Math.min(range.end, line.end),
    };
    const trimmed = trimBlank(document.chars, clamped);
    if (trimmed.start >= trimmed.end) continue;
    const bounds = { start: line.contentStart, end: line.end };
    segments.push(style === 'italic' ? snapToWords(document.chars, trimmed, bounds) : trimmed);
  }
  return segments;
}

/** Drop edge whitespace: a delimiter touching a space does not parse. */
function trimBlank(chars: string[], range: SourceRange): SourceRange {
  let { start, end } = range;
  while (start < end && isBlank(chars[start])) start += 1;
  while (end > start && isBlank(chars[end - 1])) end -= 1;
  return { start, end };
}

/** Grow a range out to whole words, never past ``bounds``. */
function snapToWords(chars: string[], range: SourceRange, bounds: SourceRange): SourceRange {
  let { start, end } = range;
  while (start > bounds.start && isWordChar(chars[start - 1])) start -= 1;
  while (end < bounds.end && isWordChar(chars[end])) end += 1;
  return { start, end };
}

/** The visible source positions a set of segments selects. */
function contentPoints(document: JournalMarkdownDocument, segments: SourceRange[]): number[] {
  return segments.flatMap((segment) => {
    const points: number[] = [];
    for (let index = segment.start; index < segment.end; index += 1) {
      if (document.formats[index]?.visible === true) points.push(index);
    }
    return points;
  });
}

/** Grow a segment over every same-style span it overlaps, collecting those spans. */
function absorbOverlaps(
  document: JournalMarkdownDocument,
  segment: SourceRange,
  style: InlineStyle,
  absorbed: Set<InlineSpan>,
): SourceRange {
  let grown = { ...segment };
  let changed = true;
  while (changed) {
    changed = false;
    for (const span of document.inlineSpans) {
      if (span.style !== style || absorbed.has(span)) continue;
      if (span.start >= grown.end || span.end <= grown.start) continue;
      absorbed.add(span);
      grown = { start: Math.min(grown.start, span.start), end: Math.max(grown.end, span.end) };
      changed = true;
    }
  }
  return grown;
}

function wrapEdits(
  document: JournalMarkdownDocument,
  segments: SourceRange[],
  style: InlineStyle,
): SourceEdit[] {
  const { open, close } = INLINE_DELIMITERS[style];
  const absorbed = new Set<InlineSpan>();
  const edits: SourceEdit[] = [];
  for (const segment of segments) {
    const grown = absorbOverlaps(document, segment, style, absorbed);
    edits.push(
      { at: grown.start, remove: 0, insert: open },
      { at: grown.end, remove: 0, insert: close },
    );
  }
  return [...[...absorbed].flatMap(unwrapSpan), ...edits];
}

function unwrapEdits(
  document: JournalMarkdownDocument,
  points: number[],
  style: InlineStyle,
): SourceEdit[] {
  const spans = document.inlineSpans.filter(
    (span) =>
      span.style === style &&
      points.some((index) => index >= span.contentStart && index < span.contentEnd),
  );
  return spans.flatMap(unwrapSpan);
}

/** Whether every selected content point carries ``style`` (a range), or the caret is inside it. */
function styleActiveAt(
  document: JournalMarkdownDocument,
  range: SourceRange,
  style: InlineStyle,
): boolean {
  if (range.start === range.end) return styleSpansAt(document, range.start, style).length > 0;
  const points = contentPoints(document, lineSegments(document, range, style));
  return points.length > 0 && points.every((index) => document.formats[index]![style]);
}

/**
 * Whether ``style`` is in force at a UTF-16 selection: for a caret, inside a
 * span of that style (delimiter edges included); for a range, on every
 * selected content character. This is what a toolbar's pressed state reads.
 */
export function inlineStyleActive(
  body: string,
  selection: MarkdownSelection,
  style: InlineStyle,
): boolean {
  return styleActiveAt(parseJournalMarkdown(body), sourceRange(body, selection), style);
}

function spellsAt(chars: string[], index: number, text: string): boolean {
  return index >= 0 && Array.from(text).every((char, offset) => chars[index + offset] === char);
}

function edit(text: string, start: number, end: number): MarkdownEdit {
  return { text, selection: { start: sourceToUtf16(text, start), end: sourceToUtf16(text, end) } };
}

/** A collapsed caret: remove an empty pair, unwrap the span it is in, or open a pair. */
function toggleAtCaret(
  document: JournalMarkdownDocument,
  caret: number,
  style: InlineStyle,
): MarkdownEdit | null {
  const { chars } = document;
  const { open, close } = INLINE_DELIMITERS[style];
  const openLength = Array.from(open).length;
  if (spellsAt(chars, caret - openLength, open) && spellsAt(chars, caret, close)) {
    const edits = [
      { at: caret - openLength, remove: openLength, insert: '' },
      { at: caret, remove: Array.from(close).length, insert: '' },
    ];
    const target = caret - openLength;
    return edit(applyEdits(chars, edits), target, target);
  }
  const owners = styleSpansAt(document, caret, style);
  if (owners.length > 0) {
    const innermost = owners.reduce((chosen, span) => (span.start > chosen.start ? span : chosen));
    const target = caret - (innermost.contentStart - innermost.start);
    return edit(applyEdits(chars, unwrapSpan(innermost)), target, target);
  }
  const text = applyEdits(chars, [{ at: caret, remove: 0, insert: `${open}${close}` }]);
  // The pair is only worth inserting if the next typed character takes the style.
  const probe = parseJournalMarkdown(
    applyEdits(Array.from(text), [{ at: caret + openLength, remove: 0, insert: 'x' }]),
  );
  if (probe.formats[caret + openLength]?.[style] !== true) return null;
  return edit(text, caret + openLength, caret + openLength);
}

/**
 * Toggle an inline style over a UTF-16 selection, or return null when the
 * action cannot produce source the dialect reads.
 *
 * A range whose content already carries the style is unwrapped (exactly the
 * spans holding it, whatever their delimiter width); any other range is
 * wrapped, one delimiter pair per selected line, absorbing same-style spans it
 * overlaps so the result never nests a style inside itself. A collapsed caret
 * removes an empty pair it sits in, unwraps the span it is inside, or opens a
 * new pair with the caret between the delimiters.
 */
export function toggleInlineStyle(
  body: string,
  selection: MarkdownSelection,
  style: InlineStyle,
): MarkdownEdit | null {
  const document = parseJournalMarkdown(body);
  const range = sourceRange(body, selection);
  if (range.start === range.end) return toggleAtCaret(document, range.start, style);

  const points = contentPoints(document, lineSegments(document, range, style));
  if (points.length === 0) return null;
  const wanted = !points.every((index) => document.formats[index]![style]);
  const edits = wanted
    ? wrapEdits(document, lineSegments(document, range, style), style)
    : unwrapEdits(document, points, style);
  const text = applyEdits(document.chars, edits);

  const result = parseJournalMarkdown(text);
  const moved = points.map((index) => shiftIndex(edits, index));
  const holds = moved.every((index) => {
    const format = result.formats[index];
    return format?.visible === true && format[style] === wanted;
  });
  if (!holds) return null;
  return edit(text, moved[0]!, moved.at(-1)! + 1);
}
