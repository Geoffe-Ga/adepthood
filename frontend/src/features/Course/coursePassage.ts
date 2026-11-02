/**
 * ``coursePassage`` — a Course quote's passage, carried back to its chapter
 * (#3659). Pure: no React, no I/O.
 *
 * A Course quote's anchors are code-point offsets into the chapter's
 * ``body_markdown`` AS SERVED -- the anchor API's own units, sliced by the
 * server. The reader never shows that string: ``stripLeadingTitleHeading``
 * drops a leading heading that repeats the title, so the selection surface
 * mirrors a SUFFIX of it, and every offset there is short by the code points
 * the heading took. {@link alignPassage} is the one place that shift happens.
 */
import type { CodePointSpan } from '../Journal/QuoteSelectionSurface';

/** A passage to open preselected: code points into ``body_markdown`` as served. */
export interface CoursePassageSpan {
  start: number;
  end: number;
  /**
   * The words the span should select, when known. A span read back off a URL
   * carries none (only the offsets travel there), and is checked by range alone.
   */
  text?: string;
}

/** How many code points ``text`` holds (an emoji is one, not two UTF-16 units). */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * The passage as the shown body indexes it, or null when it no longer fits.
 *
 * ``shown`` is ``served`` with its title heading stripped, which is always a
 * suffix of it, so the shift is the difference of their code-point lengths. A
 * span that begins inside that heading, selects nothing, runs past the shown
 * body, or -- when its words are known -- no longer holds them (the chapter was
 * re-pinned since the quote was made) does not fit, and the chapter opens as
 * it would without one.
 */
export function alignPassage(
  served: string,
  shown: string,
  passage: CoursePassageSpan,
): CodePointSpan | null {
  const shownPoints = Array.from(shown);
  const stripped = codePointLength(served) - shownPoints.length;
  const start = passage.start - stripped;
  const end = passage.end - stripped;
  if (start < 0 || end <= start || end > shownPoints.length) return null;
  if (passage.text !== undefined && shownPoints.slice(start, end).join('') !== passage.text) {
    return null;
  }
  return { start, end };
}
