/**
 * Which anchored ranges the read view actually draws, as pure offset math.
 *
 * ``HighlightedBody`` renders the body line by line: a segment becomes a run
 * only where it intersects a visible source line. A range made only of the line
 * feeds between blocks intersects none, so it renders nothing -- no
 * ``highlight-${id}`` run, no passage to measure. The margin's "drawn" test
 * asks the same question through the same helper, so the two cannot disagree.
 */
import type { AnchoredSegment } from './highlightSegments';
import { buildAnchoredSegments } from './highlightSegments';
import { parseJournalMarkdown } from './journalMarkdown';

import type { Marginalia, PromotedQuote } from '@/api';

/** A half-open code-point range. */
export interface SourceRange {
  start: number;
  end: number;
}

/** The code-point offset just past a segment. */
export function segmentEnd(segment: AnchoredSegment): number {
  return segment.start + Array.from(segment.text).length;
}

/** The part of ``segment`` on ``line``, or ``null`` when they do not meet. */
export function lineSlice(line: SourceRange, segment: AnchoredSegment): SourceRange | null {
  const start = Math.max(line.start, segment.start);
  const end = Math.min(line.end, segmentEnd(segment));
  return start < end ? { start, end } : null;
}

/**
 * The ids of the notes the read view draws a highlight run for.
 *
 * Built from ``buildAnchoredSegments`` with the arguments ``HighlightedBody``
 * gets (so a stale, out-of-range or overlap-skipped note is excluded by the
 * body's own rule), then kept only where a segment meets a rendered line (so a
 * note anchored on the blank line between two paragraphs is excluded too).
 */
export function drawnNoteIds(
  body: string,
  notes: Marginalia[],
  quotes: PromotedQuote[],
): ReadonlySet<number> {
  const lines = parseJournalMarkdown(body).blocks.flatMap((block) => block.lines);
  const ids = new Set<number>();
  for (const segment of buildAnchoredSegments(body, notes, quotes)) {
    if (segment.note && lines.some((line) => lineSlice(line, segment) !== null)) {
      ids.add(segment.note.id);
    }
  }
  return ids;
}
