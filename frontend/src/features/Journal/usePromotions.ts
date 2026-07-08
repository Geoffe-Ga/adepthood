/**
 * ``usePromotions`` — owns the promoted-quote list for one journal entry
 * (select-a-span -> promote-quote).
 *
 * ``promote`` raises a reader-selected span into the corpus and appends the
 * returned quote on success; a failure maps to a warm, non-blocking hint and
 * appends nothing. ``removePromotion`` optimistically drops a quote and reverts
 * it on error, guarding a double-tap per id (mirrors ``useResonance``'s
 * ``runDismiss``). One promote runs at a time so a double-tap can't double-post.
 */
import { useCallback, useRef, useState } from 'react';

import { promotions } from '@/api';
import type { PromotedQuote } from '@/api';
import { formatApiError } from '@/api/errorMessages';

export interface UsePromotionsArgs {
  /** The entry whose spans are being promoted. */
  entryId: number;
  /** Quotes already promoted for this entry (seeds the list). */
  initialQuotes?: PromotedQuote[];
}

export interface UsePromotionsResult {
  quotes: PromotedQuote[];
  /** Warm, declinable copy for the latest failed action; null when all is well. */
  hint: string | null;
  /** Promote the ``[start, end)`` span; appends the new quote on success. */
  promote: (_start: number, _end: number) => Promise<void>;
  /** Un-promote a quote by id; optimistic, reverting on error. */
  removePromotion: (_id: number) => Promise<void>;
}

/** Re-insert a reverted quote, keeping the list ordered by anchor then id. */
function insertSorted(quotes: PromotedQuote[], quote: PromotedQuote): PromotedQuote[] {
  return [...quotes, quote].sort((a, b) => a.anchor_start - b.anchor_start || a.id - b.id);
}

/** Drop the quote with ``id`` (a named helper so it isn't a nested callback). */
function dropById(quotes: PromotedQuote[], id: number): PromotedQuote[] {
  return quotes.filter((q) => q.id !== id);
}

export function usePromotions({
  entryId,
  initialQuotes = [],
}: UsePromotionsArgs): UsePromotionsResult {
  const [quotes, setQuotes] = useState<PromotedQuote[]>(initialQuotes);
  const [hint, setHint] = useState<string | null>(null);
  // One promote at a time; per-id guard for removals — no double-post/-delete.
  const promotingRef = useRef(false);
  const removingIdsRef = useRef<Set<number>>(new Set());

  const promote = useCallback(
    async (start: number, end: number): Promise<void> => {
      if (promotingRef.current) return;
      promotingRef.current = true;
      setHint(null);
      try {
        const created = await promotions.create(entryId, { anchor_start: start, anchor_end: end });
        setQuotes((prev) => insertSorted(prev, created));
      } catch (err) {
        setHint(formatApiError(err));
      } finally {
        promotingRef.current = false;
      }
    },
    [entryId],
  );

  const removePromotion = useCallback(
    async (id: number): Promise<void> => {
      if (removingIdsRef.current.has(id)) return;
      removingIdsRef.current.add(id);
      setHint(null);
      const removed = quotes.find((q) => q.id === id);
      setQuotes((prev) => dropById(prev, id)); // optimistic
      try {
        await promotions.remove(id);
      } catch (err) {
        if (removed) setQuotes((prev) => insertSorted(prev, removed)); // revert
        setHint(formatApiError(err));
      } finally {
        removingIdsRef.current.delete(id);
      }
    },
    [quotes],
  );

  return { quotes, hint, promote, removePromotion };
}
