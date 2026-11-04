/**
 * ``promotionTarget`` -- what a promoted quote is lifted FROM (#3660).
 *
 * A reader promotes a passage of their own entry, of a Course chapter, or of a
 * Resonance Letter, and each source has its own pair of routes (#3658). This is
 * the one place that tells them apart, so ``usePromotions`` -- and anything
 * after it, like the web highlight-to-promote of #3661 -- holds a single
 * ``PromotionTarget`` and never branches on the kind itself. Pure: no React.
 *
 * Every write sends offsets only; the server slices and snapshots the words.
 */
import { promotions } from '@/api';
import type { PromotedQuote, PromotedQuoteSourceKind, PromoteQuoteSpan } from '@/api';

/** A source a passage can be promoted from, keyed by its own id. */
export type PromotionTarget =
  | { kind: 'entry'; entryId: number }
  | { kind: 'course'; contentId: number }
  | { kind: 'letter'; marginaliaId: number };

/** The id of the target's own source row, whichever kind it is. */
export function promotionTargetId(target: PromotionTarget): number {
  switch (target.kind) {
    case 'entry':
      return target.entryId;
    case 'course':
      return target.contentId;
    case 'letter':
      return target.marginaliaId;
  }
}

/** Promote ``span`` of ``kind``'s source ``id`` over that source's own route. */
export function createPromotion(
  kind: PromotedQuoteSourceKind,
  id: number,
  span: PromoteQuoteSpan,
): Promise<PromotedQuote> {
  switch (kind) {
    case 'entry':
      return promotions.create(id, span);
    case 'course':
      return promotions.createForCourse(id, span);
    case 'letter':
      return promotions.createForLetter(id, span);
  }
}

/** Every quote promoted from one ``entry`` source, as the hydrate scaffolding wants it. */
function listEntryPromotions(id: number): Promise<{ items: PromotedQuote[] }> {
  return promotions.list(id).then((items) => ({ items }));
}

/** Every quote promoted from one Course chapter. */
function listCoursePromotions(id: number): Promise<{ items: PromotedQuote[] }> {
  return promotions.listForCourse(id).then((items) => ({ items }));
}

/** Every quote promoted from one letter. */
function listLetterPromotions(id: number): Promise<{ items: PromotedQuote[] }> {
  return promotions.listForLetter(id).then((items) => ({ items }));
}

/**
 * The reader for ``kind``'s quotes, in the ``{ items }`` shape the shared
 * hydrate hook expects. Module-scope functions, so a kind always maps to the
 * same identity and a hydration effect keyed on it re-runs only when the kind
 * really changes.
 */
export const LIST_PROMOTIONS: Readonly<
  Record<PromotedQuoteSourceKind, (_id: number) => Promise<{ items: PromotedQuote[] }>>
> = Object.freeze({
  entry: listEntryPromotions,
  course: listCoursePromotions,
  letter: listLetterPromotions,
});
