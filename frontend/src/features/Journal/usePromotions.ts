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
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/** The list's canonical order: by anchor offset, then id as a stable tiebreak. */
function byAnchorThenId(a: PromotedQuote, b: PromotedQuote): number {
  return a.anchor_start - b.anchor_start || a.id - b.id;
}

/** Re-insert a reverted quote, keeping the list ordered by anchor then id. */
function insertSorted(quotes: PromotedQuote[], quote: PromotedQuote): PromotedQuote[] {
  return [...quotes, quote].sort(byAnchorThenId);
}

/** Drop the quote with ``id`` (a named helper so it isn't a nested callback). */
function dropById(quotes: PromotedQuote[], id: number): PromotedQuote[] {
  return quotes.filter((q) => q.id !== id);
}

/**
 * Union the fetched quotes into the current list by id, keeping the ordered
 * invariant. A merge (rather than a blind replace) preserves a quote an
 * in-flight ``promote`` already appended, and dedupes when the server echoes it.
 */
function mergeById(prev: PromotedQuote[], incoming: PromotedQuote[]): PromotedQuote[] {
  const byId = new Map<number, PromotedQuote>(prev.map((q) => [q.id, q]));
  for (const q of incoming) byId.set(q.id, q);
  return [...byId.values()].sort(byAnchorThenId);
}

/** The sentinel for an unsaved entry — nothing to hydrate until it has a real id. */
const UNSAVED_ENTRY_ID = 0;

/**
 * A state updater that unions the fetched quotes into the *latest* list. Named
 * at module scope (not an inline updater) so the hydration effect stays flat,
 * and functional so it can't clobber a concurrent optimistic add or removal.
 */
function mergeFetched(fetched: PromotedQuote[]): (_prev: PromotedQuote[]) => PromotedQuote[] {
  return (prev) => mergeById(prev, fetched);
}

/**
 * Rehydrate a reopened entry's quotes. Keyed by ``entryId`` and skipped for the
 * unsaved-entry sentinel; the ``cancelled`` flag stops a slow response from
 * setting state after unmount or an id change. Merges (never replaces) so a
 * quote an in-flight ``promote`` already appended survives.
 */
function useHydrateOnOpen(
  entryId: number,
  setQuotes: Dispatch<SetStateAction<PromotedQuote[]>>,
  setHint: (_hint: string | null) => void,
): void {
  useEffect(() => {
    if (entryId <= UNSAVED_ENTRY_ID) return undefined;
    let cancelled = false;
    const hydrate = async (): Promise<void> => {
      try {
        const fetched = await promotions.list(entryId);
        if (!cancelled) setQuotes(mergeFetched(fetched));
      } catch (err) {
        if (!cancelled) setHint(formatApiError(err));
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [entryId, setQuotes, setHint]);
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
  // Mirror the latest quotes so ``removePromotion`` can look up the row it drops
  // (for revert-on-error) without depending on ``quotes`` — that keeps its
  // identity stable across every add/remove.
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  useHydrateOnOpen(entryId, setQuotes, setHint);

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

  const removePromotion = useCallback(async (id: number): Promise<void> => {
    if (removingIdsRef.current.has(id)) return;
    removingIdsRef.current.add(id);
    setHint(null);
    const removed = quotesRef.current.find((q) => q.id === id);
    setQuotes((prev) => dropById(prev, id)); // optimistic
    try {
      await promotions.remove(id);
    } catch (err) {
      if (removed) setQuotes((prev) => insertSorted(prev, removed)); // revert
      setHint(formatApiError(err));
    } finally {
      removingIdsRef.current.delete(id);
    }
  }, []);

  return { quotes, hint, promote, removePromotion };
}
