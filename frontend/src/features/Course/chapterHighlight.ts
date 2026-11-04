/**
 * ``chapterHighlight`` — the passage a Course deep link asks the reader to
 * show chosen (#3659): a promoted quote's span, opened from the Promoted
 * quotes screen.
 *
 * A Course quote's offsets are code points into ``body_markdown`` exactly as
 * the body endpoint serves it (#3658), but the reader shows that body with a
 * leading title heading stripped (``stripLeadingTitleHeading``), so the span
 * is shifted back by the code points the strip removed. The reader shows the
 * raw-text selection surface with the passage chosen, because the markdown
 * renderer cannot draw a highlight at a source offset.
 *
 * The span is trusted only while it still matches: in range of the shown body
 * and, when the quote's words ride along, over exactly those words. A chapter
 * since re-pinned to new text opens normally instead of choosing the wrong
 * passage.
 */
import type { CodePointSpan } from '../Journal/QuoteSelectionSurface';

import { stripLeadingTitleHeading } from './stripLeadingTitleHeading';

/** A passage of a chapter, in code points into its served ``body_markdown``. */
export interface ChapterHighlightSpan {
  start: number;
  end: number;
  /** The quoted words, when known, so a re-pinned chapter is not mis-selected. */
  text?: string;
}

/**
 * How many code points ``stripLeadingTitleHeading`` removed from ``md``. The
 * strip only ever drops a prefix, so this is the difference in length.
 */
export function strippedPrefixLength(md: string, title: string): number {
  return Array.from(md).length - Array.from(stripLeadingTitleHeading(md, title)).length;
}

/** True when ``value`` is a usable span (a route param can arrive as anything). */
function isSpan(value: unknown): value is ChapterHighlightSpan {
  if (typeof value !== 'object' || value === null) return false;
  const { start, end, text } = value as Record<string, unknown>;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (text === undefined || typeof text === 'string')
  );
}

/**
 * The span to pre-select in the reader's shown body, or ``undefined`` when the
 * link carries none or it no longer matches the chapter.
 */
export function resolveChapterHighlight(
  rawMarkdown: string,
  title: string,
  highlight: unknown,
): CodePointSpan | undefined {
  if (!isSpan(highlight)) return undefined;
  const shift = strippedPrefixLength(rawMarkdown, title);
  // The strip drops only a prefix, so the shown body is the rest of the raw one.
  const shown = Array.from(rawMarkdown).slice(shift);
  const start = highlight.start - shift;
  const end = highlight.end - shift;
  if (start < 0 || end <= start || end > shown.length) return undefined;
  if (highlight.text !== undefined && shown.slice(start, end).join('') !== highlight.text) {
    return undefined;
  }
  return { start, end };
}
