/**
 * Split an entry body into render segments, tagging each anchored range with its
 * note. Pure offset math — no React — so the highlight logic is unit-testable
 * apart from the ``<Text>`` tree that consumes it.
 */
import type { Marginalia } from '@/api';

export interface HighlightSegment {
  /** Character offset of this segment in the body (stable, unique → React key). */
  start: number;
  text: string;
  /** The note whose anchor this segment is, or null for plain text. */
  note: Marginalia | null;
}

/** Anchors that fall inside the body and are non-empty, earliest first. */
function usableNotes(body: string, notes: Marginalia[]): Marginalia[] {
  return notes
    .filter(
      (n) =>
        // Stale anchors no longer point at a trustworthy span, so they are not
        // drawn inline (the note itself stays openable in the margin).
        n.status !== 'stale' &&
        n.anchor_start >= 0 &&
        n.anchor_end <= body.length &&
        n.anchor_start < n.anchor_end,
    )
    .sort((a, b) => a.anchor_start - b.anchor_start);
}

export function buildHighlightSegments(body: string, notes: Marginalia[]): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const note of usableNotes(body, notes)) {
    // Skip any anchor that overlaps a range we've already committed to — first
    // (earliest-start) wins, deterministically.
    if (note.anchor_start < cursor) continue;
    if (note.anchor_start > cursor) {
      segments.push({ start: cursor, text: body.slice(cursor, note.anchor_start), note: null });
    }
    segments.push({
      start: note.anchor_start,
      text: body.slice(note.anchor_start, note.anchor_end),
      note,
    });
    cursor = note.anchor_end;
  }
  if (cursor < body.length) {
    segments.push({ start: cursor, text: body.slice(cursor), note: null });
  }
  if (segments.length === 0) segments.push({ start: 0, text: body, note: null });
  return segments;
}
