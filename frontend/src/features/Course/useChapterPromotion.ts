/**
 * ``useChapterPromotion`` -- promote a passage of a Course chapter (#3660).
 *
 * The chapter's selection surface mirrors its body with the title heading
 * stripped (``stripLeadingTitleHeading``), but a Course quote's offsets index
 * ``body_markdown`` exactly as the body route serves it, which is what the
 * server slices. So the span the surface emits is shifted forward by the code
 * points the strip removed before it is posted; only offsets ever go up.
 *
 * The first promote goes through the same one-time explainer as a journal
 * page's (``usePromoteExplainer``), shown at the Promote press because the
 * passage is already chosen by then: Select a passage opens a gesture that can
 * end in a note as easily as in a promote, so a note about promoting would be
 * premature any earlier.
 *
 * The reader stays in selection mode after a promote, so they keep their place
 * and can lift the next passage; ``clearKey`` moves on each time a quote lands,
 * which tells the surface to let the promoted passage go.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CodePointSpan } from '../Journal/QuoteSelectionSurface';
import { usePromoteExplainer, type PromoteExplainerGate } from '../Journal/usePromoteExplainer';
import { usePromotions } from '../Journal/usePromotions';

import { strippedPrefixLength } from './chapterHighlight';

/** The promote lifecycle the chapter's notice reads. */
export interface ChapterPromotionFeedback {
  promoting: boolean;
  hint: string | null;
  promoted: boolean;
  retryPromote: (() => Promise<void>) | null;
}

export interface ChapterPromotion {
  /** The pill's primary: explain first (once), else promote the chosen passage. */
  onPromote: () => Promise<void>;
  /** A promote is in flight, so the pill shows busy. */
  busy: boolean;
  /** Moves on each time a quote lands, so the surface can clear the passage. */
  clearKey: number;
  feedback: ChapterPromotionFeedback;
  explainer: PromoteExplainerGate;
}

/**
 * Bump a key each time a quote lands (the list only grows by a promote here:
 * the chapter reads no quotes on open), so a retried promote clears the
 * passage just as a first-time one does.
 */
function useLandedKey(count: number): number {
  const [key, setKey] = useState(0);
  const seen = useRef(count);
  useEffect(() => {
    if (count > seen.current) setKey((previous) => previous + 1);
    seen.current = count;
  }, [count]);
  return key;
}

/**
 * Promote passages of chapter ``contentId``. ``served`` is ``body_markdown`` as
 * the route served it and ``title`` the chapter's title, which together say how
 * many code points the shown text lacks; ``span`` is the surface's latest span
 * in the shown text, or null while nothing is chosen.
 */
export function useChapterPromotion(
  contentId: number,
  served: string,
  title: string,
  span: CodePointSpan | null,
): ChapterPromotion {
  const { quotes, hint, promote, promoting, promoted, retryPromote } = usePromotions({
    target: { kind: 'course', contentId },
    // A rendered chapter carries no offsets to draw a highlight at, so nothing
    // is read on open.
    hydrate: false,
  });
  const shift = useMemo(() => strippedPrefixLength(served, title), [served, title]);
  // Read at press time: the explainer's go-ahead arrives after the render that
  // showed it, and must promote the passage chosen then, not one captured earlier.
  const spanRef = useRef(span);
  spanRef.current = span;

  const promoteChosen = useCallback((): void => {
    const chosen = spanRef.current;
    if (chosen === null || chosen.end <= chosen.start) return;
    void promote(chosen.start + shift, chosen.end + shift);
  }, [promote, shift]);

  const explainer = usePromoteExplainer(promoteChosen);
  const { onPress } = explainer;
  const onPromote = useCallback(async (): Promise<void> => onPress(), [onPress]);
  const clearKey = useLandedKey(quotes.length);

  return {
    onPromote,
    busy: promoting,
    clearKey,
    feedback: { promoting, hint, promoted, retryPromote },
    explainer,
  };
}
