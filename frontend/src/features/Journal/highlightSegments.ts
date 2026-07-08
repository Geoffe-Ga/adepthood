/**
 * Split an entry body into render segments, tagging each anchored range with its
 * note and/or promoted quote. Pure offset math — no React — so the highlight
 * logic is unit-testable apart from the ``<Text>`` tree that consumes it.
 */
import type { Marginalia, PromotedQuote } from '@/api';

export interface HighlightSegment {
  /** Character offset of this segment in the body (stable, unique → React key). */
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

/** An anchor is drawn only if it falls inside the body and is non-empty. */
function inRange(body: string, start: number, end: number): boolean {
  return start >= 0 && end <= body.length && start < end;
}

/** Live (non-stale), in-range note anchors — stale notes are not drawn inline. */
function noteAnchors(body: string, notes: Marginalia[]): Anchor[] {
  return notes
    .filter((n) => n.status !== 'stale' && inRange(body, n.anchor_start, n.anchor_end))
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
function quoteAnchors(body: string, quotes: PromotedQuote[]): Anchor[] {
  return quotes
    .filter((q) => inRange(body, q.anchor_start, q.anchor_end))
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
function usableAnchors(body: string, notes: Marginalia[], quotes: PromotedQuote[]): Anchor[] {
  return [...noteAnchors(body, notes), ...quoteAnchors(body, quotes)].sort(
    (a, b) => a.start - b.start || a.order - b.order || a.id - b.id,
  );
}

/**
 * Segment the body against the merged note + quote anchor stream. The same
 * first-wins cursor-skip rule as the notes-only path resolves overlaps: the
 * earliest-starting anchor wins and any anchor overlapping a committed range is
 * skipped.
 */
export function buildAnchoredSegments(
  body: string,
  notes: Marginalia[],
  quotes: PromotedQuote[],
): AnchoredSegment[] {
  const segments: AnchoredSegment[] = [];
  let cursor = 0;
  for (const anchor of usableAnchors(body, notes, quotes)) {
    if (anchor.start < cursor) continue; // overlaps a committed range — skip it
    if (anchor.start > cursor) {
      segments.push({
        start: cursor,
        text: body.slice(cursor, anchor.start),
        note: null,
        quote: null,
      });
    }
    segments.push({
      start: anchor.start,
      text: body.slice(anchor.start, anchor.end),
      note: anchor.note,
      quote: anchor.quote,
    });
    cursor = anchor.end;
  }
  if (cursor < body.length) {
    segments.push({ start: cursor, text: body.slice(cursor), note: null, quote: null });
  }
  if (segments.length === 0) segments.push({ start: 0, text: body, note: null, quote: null });
  return segments;
}

/**
 * The notes-only segmentation the read-mode highlight tree consumes. A thin
 * wrapper over {@link buildAnchoredSegments} (no quotes) that drops the quote
 * key, so its shape and behaviour stay exactly as before.
 */
export function buildHighlightSegments(body: string, notes: Marginalia[]): HighlightSegment[] {
  return buildAnchoredSegments(body, notes, []).map(({ start, text, note }) => ({
    start,
    text,
    note,
  }));
}
