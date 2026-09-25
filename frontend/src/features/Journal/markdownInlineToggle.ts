/**
 * Bold / italic / underline as editor actions over the journal's source.
 *
 * Every action rewrites the canonical source and nothing else: it inserts or
 * removes the delimiters the parser reads (``INLINE_DELIMITERS``), and it
 * proves the result by re-parsing the WHOLE body. The postcondition is the
 * contract, not a courtesy: every character that was there before must keep
 * its visibility and every style but the requested one, the requested style
 * may change only on the characters the action acts on, and every delimiter
 * the action inserts must parse as a delimiter. Anything else -- a closer
 * escaped by a backslash, a mid-word underscore, an unmatched ``<u>`` earlier
 * on the line capturing the new closer -- is refused (``null``) instead of
 * being written as corrupt source.
 *
 * The web textarea holds the raw source, so a caret or a selection edge can
 * sit inside a hidden delimiter run. A caret on or inside a same-style span's
 * delimiters belongs to that span (the action turns it off); inside another
 * style's delimiters it steps out of them first. A range edge inside
 * delimiters is trimmed back to the content, the way edge whitespace is.
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
  type CharacterFormat,
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

/** A result character, and the source index it came from (null when inserted). */
interface Cell {
  char: string;
  origin: number | null;
}

const STYLES: readonly InlineStyle[] = ['bold', 'italic', 'underline'];

/** What the postcondition expects of one toggle. */
interface Expectation {
  style: InlineStyle;
  /** The value ``style`` must take on the visible characters acted on. */
  wanted: boolean;
  /** Whether a source index is one the action acts on. */
  acts: (index: number) => boolean;
  /** The format each inserted character must have (by position among the inserted). */
  inserted: (position: number, format: CharacterFormat) => boolean;
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
function applyEdits(chars: string[], edits: SourceEdit[]): Cell[] {
  const next: Cell[] = chars.map((char, origin) => ({ char, origin }));
  const ordered = [...edits].sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const edit of ordered) {
    const inserted = Array.from(edit.insert).map((char) => ({ char, origin: null }));
    next.splice(edit.at, edit.remove, ...inserted);
  }
  return next;
}

function textOf(cells: Cell[]): string {
  return cells.map((cell) => cell.char).join('');
}

/** Where a source position (a caret boundary) lands once ``edits`` are applied. */
function remapPosition(edits: SourceEdit[], position: number): number {
  let shifted = position;
  for (const edit of edits) {
    const end = edit.at + edit.remove;
    if (position >= end) shifted += Array.from(edit.insert).length - edit.remove;
    else if (position > edit.at) shifted -= position - edit.at;
  }
  return shifted;
}

/** Whether the re-parsed result keeps every promise listed in ``expectation``. */
function holds(before: JournalMarkdownDocument, cells: Cell[], expectation: Expectation): boolean {
  const after = parseJournalMarkdown(textOf(cells));
  let insertedSeen = 0;
  return cells.every((cell, index) => {
    const format = after.formats[index]!;
    if (cell.origin == null) {
      insertedSeen += 1;
      return expectation.inserted(insertedSeen - 1, format);
    }
    const old = before.formats[cell.origin]!;
    if (format.visible !== old.visible) return false;
    const { style } = expectation;
    if (STYLES.some((other) => other !== style && format[other] !== old[other])) return false;
    if (!expectation.acts(cell.origin)) return format[style] === old[style];
    return !old.visible || format[style] === expectation.wanted;
  });
}

/** Every inserted character is a delimiter the parser read. */
function insertedHidden(_position: number, format: CharacterFormat): boolean {
  return !format.visible;
}

/** Spans of one style whose delimiters or content hold a caret, edges included. */
function spansAround(
  document: JournalMarkdownDocument,
  caret: number,
  style: InlineStyle,
): InlineSpan[] {
  return document.inlineSpans.filter(
    (span) => span.style === style && span.start <= caret && caret <= span.end,
  );
}

/** Both delimiter runs of a span, as removals. */
function unwrapSpan(span: InlineSpan): SourceEdit[] {
  return [
    { at: span.start, remove: span.contentStart - span.start, insert: '' },
    { at: span.contentEnd, remove: span.end - span.contentEnd, insert: '' },
  ];
}

/** Drop edge whitespace and hidden delimiters: a pair must wrap visible content. */
function trimEdges(document: JournalMarkdownDocument, range: SourceRange): SourceRange {
  const { chars, formats } = document;
  const skip = (index: number): boolean => isBlank(chars[index]) || !formats[index]!.visible;
  let { start, end } = range;
  while (start < end && skip(start)) start += 1;
  while (end > start && skip(end - 1)) end -= 1;
  return { start, end };
}

/** Grow a range out to whole words, never past ``bounds``. */
function snapToWords(chars: string[], range: SourceRange, bounds: SourceRange): SourceRange {
  let { start, end } = range;
  while (start > bounds.start && isWordChar(chars[start - 1])) start -= 1;
  while (end < bounds.end && isWordChar(chars[end])) end += 1;
  return { start, end };
}

/**
 * One line's slice of a selection, clamped to the line's content, trimmed of
 * edge whitespace and delimiters, and -- for italic, whose ``_`` the dialect
 * ignores inside a word -- snapped outward to whole words. Empty slices are
 * dropped.
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
    const trimmed = trimEdges(document, clamped);
    if (trimmed.start >= trimmed.end) continue;
    const bounds = { start: line.contentStart, end: line.end };
    segments.push(style === 'italic' ? snapToWords(document.chars, trimmed, bounds) : trimmed);
  }
  return segments;
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

function inAny(ranges: SourceRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/** Wrap each segment in a new pair, absorbing the same-style spans it overlaps. */
function wrapRange(
  document: JournalMarkdownDocument,
  segments: SourceRange[],
  style: InlineStyle,
): { edits: SourceEdit[]; expectation: Expectation } {
  const { open, close } = INLINE_DELIMITERS[style];
  const absorbed = new Set<InlineSpan>();
  const grown = segments.map((segment) => absorbOverlaps(document, segment, style, absorbed));
  const edits = [
    ...[...absorbed].flatMap(unwrapSpan),
    ...grown.flatMap((range) => [
      { at: range.start, remove: 0, insert: open },
      { at: range.end, remove: 0, insert: close },
    ]),
  ];
  const acts = (index: number): boolean => inAny(grown, index);
  return { edits, expectation: { style, wanted: true, acts, inserted: insertedHidden } };
}

/** Remove every span of the style that holds a selected content point. */
function unwrapRange(
  document: JournalMarkdownDocument,
  points: number[],
  style: InlineStyle,
): { edits: SourceEdit[]; expectation: Expectation } {
  const spans = document.inlineSpans.filter(
    (span) =>
      span.style === style &&
      points.some((index) => index >= span.contentStart && index < span.contentEnd),
  );
  const contents = spans.map((span) => ({ start: span.contentStart, end: span.contentEnd }));
  const acts = (index: number): boolean => inAny(contents, index);
  return {
    edits: spans.flatMap(unwrapSpan),
    expectation: { style, wanted: false, acts, inserted: insertedHidden },
  };
}

/** Whether every selected content point carries ``style`` (a range), or the caret belongs to a span of it. */
function styleActiveAt(
  document: JournalMarkdownDocument,
  range: SourceRange,
  style: InlineStyle,
): boolean {
  if (range.start === range.end) return spansAround(document, range.start, style).length > 0;
  const points = contentPoints(document, lineSegments(document, range, style));
  return points.length > 0 && points.every((index) => document.formats[index]![style]);
}

/**
 * Whether ``style`` is in force at a UTF-16 selection: for a caret, on or
 * inside a span of that style (its delimiters included, since pressing the
 * control there turns that span off); for a range, on every selected content
 * character. This is what a toolbar's pressed state reads.
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

/** Commit ``edits`` if the postcondition holds, with the caret remapped. */
function commit(
  document: JournalMarkdownDocument,
  edits: SourceEdit[],
  expectation: Expectation,
  caret: number,
): MarkdownEdit | null {
  const cells = applyEdits(document.chars, edits);
  if (!holds(document, cells, expectation)) return null;
  const target = remapPosition(edits, caret);
  return edit(textOf(cells), target, target);
}

/** A caret inside another span's delimiter run steps out of it, to the span's outer edge. */
function stepOutOfDelimiters(document: JournalMarkdownDocument, caret: number): number {
  let at = caret;
  let moved = true;
  while (moved) {
    moved = false;
    for (const span of document.inlineSpans) {
      if (span.start < at && at < span.contentStart) at = span.start;
      else if (span.contentEnd < at && at < span.end) at = span.end;
      else continue;
      moved = true;
    }
  }
  return at;
}

const NOTHING_ACTS = (): boolean => false;

/** A collapsed caret: remove an empty pair, unwrap the span it belongs to, or open a pair. */
function toggleAtCaret(
  document: JournalMarkdownDocument,
  caret: number,
  style: InlineStyle,
): MarkdownEdit | null {
  const { chars } = document;
  const { open, close } = INLINE_DELIMITERS[style];
  const openLength = Array.from(open).length;
  const closeLength = Array.from(close).length;
  if (spellsAt(chars, caret - openLength, open) && spellsAt(chars, caret, close)) {
    const edits = [
      { at: caret - openLength, remove: openLength, insert: '' },
      { at: caret, remove: closeLength, insert: '' },
    ];
    const expectation = { style, wanted: false, acts: NOTHING_ACTS, inserted: insertedHidden };
    return commit(document, edits, expectation, caret);
  }
  const owners = spansAround(document, caret, style);
  if (owners.length > 0) {
    const innermost = owners.reduce((chosen, span) => (span.start > chosen.start ? span : chosen));
    const content = { start: innermost.contentStart, end: innermost.contentEnd };
    const acts = (index: number): boolean => inAny([content], index);
    const expectation = { style, wanted: false, acts, inserted: insertedHidden };
    return commit(document, unwrapSpan(innermost), expectation, caret);
  }
  const at = stepOutOfDelimiters(document, caret);
  // Judged with a probe typed between the new delimiters: the pair is only
  // worth inserting if the next character takes the style, the delimiters
  // then parse as delimiters, and nothing already there changes.
  const probe = applyEdits(chars, [{ at, remove: 0, insert: `${open}x${close}` }]);
  const probeExpectation: Expectation = {
    style,
    wanted: false,
    acts: NOTHING_ACTS,
    inserted: (position, format) =>
      position === openLength ? format.visible && format[style] : !format.visible,
  };
  if (!holds(document, probe, probeExpectation)) return null;
  const text = textOf(applyEdits(chars, [{ at, remove: 0, insert: `${open}${close}` }]));
  return edit(text, at + openLength, at + openLength);
}

/**
 * Toggle an inline style over a UTF-16 selection, or return null when the
 * action cannot produce source the dialect reads without disturbing the rest.
 *
 * A range whose content already carries the style is unwrapped (exactly the
 * spans holding it, whatever their delimiter width); any other range is
 * wrapped, one delimiter pair per selected line, absorbing same-style spans it
 * overlaps so the result never nests a style inside itself. A collapsed caret
 * removes an empty pair it sits in, unwraps the span it belongs to, or opens a
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

  const segments = lineSegments(document, range, style);
  const points = contentPoints(document, segments);
  if (points.length === 0) return null;
  const alreadyStyled = points.every((index) => document.formats[index]![style]);
  const { edits, expectation } = alreadyStyled
    ? unwrapRange(document, points, style)
    : wrapRange(document, segments, style);
  const cells = applyEdits(document.chars, edits);
  if (!holds(document, cells, expectation)) return null;
  // The returned selection covers everything the style changed on: an unwrap
  // of a span wider than the selection shows the writer all of it.
  const acted = cells.flatMap((cell, index) =>
    cell.origin != null &&
    document.formats[cell.origin]!.visible &&
    (points.includes(cell.origin) || expectation.acts(cell.origin))
      ? [index]
      : [],
  );
  return edit(textOf(cells), acted[0]!, acted.at(-1)! + 1);
}
