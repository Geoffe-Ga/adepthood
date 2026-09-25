/**
 * Caret and reveal geometry over a parsed document -- render-side only.
 *
 * The textarea stays the source of truth for the caret: a real selection index
 * is converted straight from UTF-16 to a source position by ``utf16ToSource``,
 * which is exact on every position a caret can actually occupy. The mapping
 * here is for presentation -- a styled overlay that must know which rendered
 * glyph a source position draws, and which delimiters to reveal around it.
 *
 * Nothing in this module writes to the document. ``visible: false`` describes a
 * character that is still in the source stream at its own offset; revealing it
 * is a derived range, never a mutation.
 */
import type { InlineSpan, JournalMarkdownDocument, SourceLine } from './journalMarkdownTypes';

/** A span of inline emphasis, delimiters included. */
export interface JournalMarkdownSpan {
  /** Source range covering the styled text AND its hidden delimiters. */
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** A collapsed caret or a selected range, in source positions. */
export interface SourceSelection {
  start: number;
  end: number;
}

function clamp(value: number, limit: number): number {
  return Math.max(0, Math.min(value, limit));
}

function isHidden(document: JournalMarkdownDocument, index: number): boolean {
  return document.formats[index]?.visible === false;
}

/** How many rendered characters precede this source position. */
export function sourceToVisible(document: JournalMarkdownDocument, sourceIndex: number): number {
  const bounded = clamp(sourceIndex, document.chars.length);
  let visible = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (document.formats[index]?.visible === true) visible += 1;
  }
  return visible;
}

/** Source position of the ``visibleIndex``-th rendered character, or the end. */
function visibleAnchor(document: JournalMarkdownDocument, visibleIndex: number): number {
  let seen = 0;
  for (let index = 0; index < document.chars.length; index += 1) {
    if (document.formats[index]?.visible !== true) continue;
    if (seen === visibleIndex) return index;
    seen += 1;
  }
  return document.chars.length;
}

/**
 * The source position a rendered caret position names.
 *
 * Two documented tie-break rules, because a hidden run collapses several source
 * positions onto one rendered one:
 *
 * 1. A rendered position preceded by a hidden run that starts the DOCUMENT binds
 *    to source 0 -- outside the span. A caret at the very start of ``**bold**``
 *    genuinely is at source 0, before the writer has typed anything, and naming
 *    it source 2 would jump the caret forward and reveal the delimiters
 *    spuriously.
 * 2. Every other rendered position binds to its own character's source index,
 *    which places the caret inside the span it is rendering -- the behaviour
 *    that makes typing at the edge of ``a**b**c`` continue the emphasis.
 *
 * This is presentation geometry. A caret that came from the textarea is
 * converted with ``utf16ToSource`` instead, which loses nothing.
 */
export function visibleToSource(document: JournalMarkdownDocument, visibleIndex: number): number {
  const total = sourceToVisible(document, document.chars.length);
  const anchor = visibleAnchor(document, clamp(visibleIndex, total));
  let leading = anchor;
  while (leading > 0 && isHidden(document, leading - 1)) leading -= 1;
  return leading === 0 ? 0 : anchor;
}

/** The recorded delimiter pairs whose source range covers this position. */
function owningSpans(document: JournalMarkdownDocument, sourceIndex: number): InlineSpan[] {
  return document.inlineSpans.filter((span) => sourceIndex >= span.start && sourceIndex < span.end);
}

/**
 * The outermost of several overlapping owners.
 *
 * Earliest start is enough to identify it: a source position opens at most one
 * delimiter pair, because `isMarkerRun` requires a whole run and the passes are
 * keyed by distinct marker/width combinations, and the only tag pair opens on
 * `<`, which no symmetric pass uses. (Brute-forced over every body of up to six
 * tokens from `*`, `_`, `<u>`, `</u>`, `a`, space, `\\`, `-`, `>`: no two
 * recorded pairs ever share a start.)
 */
function outermost(owners: InlineSpan[]): InlineSpan {
  return owners.reduce((chosen, span) => (span.start < chosen.start ? span : chosen));
}

/**
 * The inline emphasis span containing a source position, delimiters included,
 * or null when the position is ordinary prose or a block prefix.
 *
 * Bounds come from the delimiter pairs the parser actually matched, never from
 * walking the hidden flag: two spans can abut with no visible character between
 * them (``**bold**_italic_``), and a hidden block prefix can sit flush against
 * an emphasis delimiter (``- **a**``). Walking hidden characters fuses all
 * three, which made a span's own closing delimiter report its neighbour's style
 * and made a bullet marker reachable as inline punctuation.
 *
 * With nesting (``*_both_*``) the position is inside more than one pair. The
 * range reported is then the outermost owner -- what a reveal must un-hide --
 * while the style flags are the union of every owner, which is what is actually
 * in force at that position.
 */
export function spanAt(
  document: JournalMarkdownDocument,
  sourceIndex: number,
): JournalMarkdownSpan | null {
  if (sourceIndex < 0 || sourceIndex >= document.chars.length) return null;
  const owners = owningSpans(document, sourceIndex);
  if (owners.length === 0) return null;
  const { start, end } = outermost(owners);
  return {
    start,
    end,
    bold: owners.some((span) => span.style === 'bold'),
    italic: owners.some((span) => span.style === 'italic'),
    underline: owners.some((span) => span.style === 'underline'),
  };
}

/** The hidden runs inside one span, as source ranges. */
function hiddenRuns(document: JournalMarkdownDocument, span: SourceLine): SourceLine[] {
  const runs: SourceLine[] = [];
  let index = span.start;
  while (index < span.end) {
    if (!isHidden(document, index)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < span.end && isHidden(document, index)) index += 1;
    runs.push({ start, end: index });
  }
  return runs;
}

/** Spans a collapsed caret sits strictly inside -- never one it merely abuts. */
function spansAtCaret(document: JournalMarkdownDocument, caret: number): JournalMarkdownSpan[] {
  const candidates = [spanAt(document, caret), spanAt(document, caret - 1)];
  const inside: JournalMarkdownSpan[] = [];
  for (const span of candidates) {
    if (span == null || span.start >= caret || caret >= span.end) continue;
    if (!inside.some((seen) => seen.start === span.start)) inside.push(span);
  }
  return inside;
}

/** Every span a selected range touches. */
function spansInRange(
  document: JournalMarkdownDocument,
  low: number,
  high: number,
): JournalMarkdownSpan[] {
  const spans: JournalMarkdownSpan[] = [];
  for (let index = Math.max(0, low); index < high; index += 1) {
    const span = spanAt(document, index);
    if (span == null || spans.some((seen) => seen.start === span.start)) continue;
    spans.push(span);
  }
  return spans;
}

/**
 * Delimiter ranges a selection should reveal, derived fresh on every call.
 *
 * A collapsed caret reveals a span only when it sits STRICTLY inside it. A
 * caret at source 0 of ``**bold**`` -- the document start, before the writer
 * has typed anything -- abuts the opening delimiters without being in the span,
 * and revealing there would make the markers flash on an empty page. The same
 * rule keeps the caret just past a closing delimiter quiet. A selected range
 * reveals every span it touches, because the writer is looking at all of it.
 *
 * The stored document is only read: no ``visible`` flag is ever written, which
 * is what keeps reveal-on-active a render concern and the body byte-identical
 * across caret movement.
 */
export function revealedDelimiters(
  document: JournalMarkdownDocument,
  selection: SourceSelection,
): SourceLine[] {
  const low = Math.min(selection.start, selection.end);
  const high = Math.max(selection.start, selection.end);
  const spans = low === high ? spansAtCaret(document, low) : spansInRange(document, low, high);
  return spans.flatMap((span) => hiddenRuns(document, span)).sort((a, b) => a.start - b.start);
}
