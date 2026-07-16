/**
 * Split an entry body into render segments, tagging each anchored range with its
 * note and/or promoted quote. Pure offset math — no React — so the highlight
 * logic is unit-testable apart from the ``<Text>`` tree that consumes it.
 */
import type { Marginalia, PromotedQuote } from '@/api';

export interface HighlightSegment {
  /** Code-point offset of this segment in the body (stable, unique → React key). */
  start: number;
  text: string;
  /** The note whose anchor this segment is, or null for plain text. */
  note: Marginalia | null;
}

/** A segment that may carry a margin note, a promoted quote, or neither. */
export interface AnchoredSegment extends HighlightSegment {
  /** The promoted quote whose anchor this segment is, or null. */
  quote: PromotedQuote | null;
}

/** ``order`` keeps a note ahead of a quote when the two share an anchor_start. */
const NOTE_ORDER = 0;
const QUOTE_ORDER = 1;

/** A margin note or a promoted quote reduced to a comparable anchored range. */
interface Anchor {
  start: number;
  end: number;
  order: number;
  id: number;
  note: Marginalia | null;
  quote: PromotedQuote | null;
}

/**
 * An anchor is drawn only if it falls inside the body and is non-empty. Anchor
 * offsets are Unicode code points, so the bound is the body's code-point length
 * (``length``), not its UTF-16 code-unit length.
 */
function inRange(length: number, start: number, end: number): boolean {
  return start >= 0 && end <= length && start < end;
}

/** Live (non-stale), in-range note anchors — stale notes are not drawn inline. */
function noteAnchors(length: number, notes: Marginalia[]): Anchor[] {
  return notes
    .filter((n) => n.status !== 'stale' && inRange(length, n.anchor_start, n.anchor_end))
    .map((n) => ({
      start: n.anchor_start,
      end: n.anchor_end,
      order: NOTE_ORDER,
      id: n.id,
      note: n,
      quote: null,
    }));
}

/** In-range quote anchors (quotes have no stale status to filter on). */
function quoteAnchors(length: number, quotes: PromotedQuote[]): Anchor[] {
  return quotes
    .filter((q) => inRange(length, q.anchor_start, q.anchor_end))
    .map((q) => ({
      start: q.anchor_start,
      end: q.anchor_end,
      order: QUOTE_ORDER,
      id: q.id,
      note: null,
      quote: q,
    }));
}

/** Merge + sort by (anchor_start, note-before-quote at equal start, then id). */
function usableAnchors(length: number, notes: Marginalia[], quotes: PromotedQuote[]): Anchor[] {
  return [...noteAnchors(length, notes), ...quoteAnchors(length, quotes)].sort(
    (a, b) => a.start - b.start || a.order - b.order || a.id - b.id,
  );
}

/**
 * Segment the body against the merged note + quote anchor stream. Overlaps
 * resolve first-wins: the earliest-starting anchor wins and any anchor
 * overlapping a committed range is skipped.
 *
 * All slicing happens in CODE-POINT space (``chars``), matching the anchor
 * contract, so a non-BMP character (emoji / astral) never shifts a boundary or
 * gets cut mid-surrogate.
 */
export function buildAnchoredSegments(
  body: string,
  notes: Marginalia[],
  quotes: PromotedQuote[],
): AnchoredSegment[] {
  const chars = Array.from(body);
  const segments: AnchoredSegment[] = [];
  let cursor = 0;
  for (const anchor of usableAnchors(chars.length, notes, quotes)) {
    if (anchor.start < cursor) continue; // overlaps a committed range — skip it
    if (anchor.start > cursor) {
      segments.push({
        start: cursor,
        text: chars.slice(cursor, anchor.start).join(''),
        note: null,
        quote: null,
      });
    }
    segments.push({
      start: anchor.start,
      text: chars.slice(anchor.start, anchor.end).join(''),
      note: anchor.note,
      quote: anchor.quote,
    });
    cursor = anchor.end;
  }
  if (cursor < chars.length) {
    segments.push({ start: cursor, text: chars.slice(cursor).join(''), note: null, quote: null });
  }
  if (segments.length === 0) segments.push({ start: 0, text: body, note: null, quote: null });
  return segments;
}
