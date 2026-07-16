/**
 * ``usePromotions`` — owns the promoted-quote list for one journal entry
 * (select-a-span -> promote-quote).
 *
 * ``promote`` raises a reader-selected span into the corpus and appends the
 * returned quote on success; a failure maps to a warm, non-blocking hint and
 * appends nothing. ``removePromotion`` drops a quote optimistically and reverts
 * it on error via the shared optimistic-remove primitive. One promote runs at a
 * time so a double-tap can't double-post.
 */
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mergeByIdSorted, useHydrateOnOpen } from './entryList';
import { optimisticRemove } from './optimisticRemove';

import { promotions } from '@/api';
import type { PromotedQuote } from '@/api';
import { formatApiError } from '@/api/errorMessages';

export interface UsePromotionsArgs {
  /** The entry whose spans are being promoted. */
  entryId: number;
  /** Quotes already promoted for this entry (seeds the list). */
  initialQuotes?: PromotedQuote[];
}

/**
 * How long the transient "Promoted" confirmation stays up before it auto-clears.
 * Exported so the screen and its tests share one source of truth for the notice.
 */
export const PROMOTED_NOTICE_MS = 2500;

export interface UsePromotionsResult {
  quotes: PromotedQuote[];
  /** Warm, declinable copy for the latest failed action; null when all is well. */
  hint: string | null;
  /** Promote the ``[start, end)`` span; appends the new quote on success. */
  promote: (_start: number, _end: number) => Promise<void>;
  /** Un-promote a quote by id; optimistic, reverting on error. */
  removePromotion: (_id: number) => Promise<void>;
  /** True while a promote POST is in flight (render mirror of the single-flight guard). */
  promoting: boolean;
  /** True briefly after a successful promote; auto-clears after {@link PROMOTED_NOTICE_MS}. */
  promoted: boolean;
  /**
   * Re-post the last attempted span with the same anchors; null unless the most
   * recent promote failed. Cleared once a subsequent promote succeeds.
   */
  retryPromote: (() => Promise<void>) | null;
}

/** The list's canonical order: by anchor offset, then id as a stable tiebreak. */
function byAnchorThenId(a: PromotedQuote, b: PromotedQuote): number {
  return a.anchor_start - b.anchor_start || a.id - b.id;
}

/** Re-insert a quote, keeping the list ordered by anchor then id and deduped. */
function insertSorted(quotes: PromotedQuote[], quote: PromotedQuote): PromotedQuote[] {
  return mergeByIdSorted(quotes, [quote], byAnchorThenId);
}

/**
 * Adapt ``promotions.list``'s bare array into the ``{ items }`` shape the shared
 * hydrate hook expects. Named at module scope so its identity is stable and the
 * hydration effect doesn't re-run on every render.
 */
function listPromotions(entryId: number): Promise<{ items: PromotedQuote[] }> {
  return promotions.list(entryId).then((items) => ({ items }));
}

/** The span most recently handed to ``promote`` — held so a retry re-posts it. */
interface Span {
  start: number;
  end: number;
}

/**
 * Auto-clear the transient "Promoted" notice after {@link PROMOTED_NOTICE_MS}.
 * Flat and unmount-safe: the timer is cleared on cleanup so an unmount mid-notice
 * never sets state, and it re-arms only while ``promoted`` is true.
 */
function usePromotedNotice(promoted: boolean, clear: () => void): void {
  useEffect(() => {
    if (!promoted) return undefined;
    const timer = setTimeout(clear, PROMOTED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [promoted, clear]);
}

/** The promote-lifecycle slice: pending/success signals plus a retryable post. */
interface PromoteAction {
  promote: (_start: number, _end: number) => Promise<void>;
  retryPromote: (() => Promise<void>) | null;
  promoting: boolean;
  promoted: boolean;
  /** Drop a pending promote retry so an unrelated failure can't re-offer it. */
  clearRetry: () => void;
}

/**
 * Own the promote lifecycle for one entry: the single-flight ``create`` (never
 * throws — failures map to ``setHint``), the ``promoting``/``promoted`` render
 * signals, and a ``retryPromote`` that re-posts the last attempted span verbatim
 * so a failure never loses the reader's selection.
 */
function usePromoteAction(
  entryId: number,
  setQuotes: Dispatch<SetStateAction<PromotedQuote[]>>,
  setHint: (_hint: string | null) => void,
): PromoteAction {
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const [promoteFailed, setPromoteFailed] = useState(false);
  // One promote at a time — the ref is the synchronous guard, the state is its
  // render mirror. The last span is held so ``retryPromote`` re-posts the same
  // anchors rather than re-deriving them from a now-stale selection.
  const promotingRef = useRef(false);
  const lastSpanRef = useRef<Span>({ start: 0, end: 0 });

  const clearPromoted = useCallback(() => setPromoted(false), []);
  usePromotedNotice(promoted, clearPromoted);

  const promote = useCallback(
    async (start: number, end: number): Promise<void> => {
      if (promotingRef.current) return;
      lastSpanRef.current = { start, end };
      promotingRef.current = true;
      setPromoting(true);
      setHint(null);
      try {
        const created = await promotions.create(entryId, { anchor_start: start, anchor_end: end });
        setQuotes((prev) => insertSorted(prev, created));
        setPromoted(true);
        setPromoteFailed(false);
      } catch (err) {
        setHint(formatApiError(err));
        setPromoteFailed(true);
      } finally {
        promotingRef.current = false;
        setPromoting(false);
      }
    },
    [entryId, setQuotes, setHint],
  );

  const retryCallback = useCallback((): Promise<void> => {
    const { start, end } = lastSpanRef.current;
    return promote(start, end);
  }, [promote]);
  const clearRetry = useCallback(() => setPromoteFailed(false), []);

  return {
    promote,
    retryPromote: promoteFailed ? retryCallback : null,
    promoting,
    promoted,
    clearRetry,
  };
}

export function usePromotions({
  entryId,
  initialQuotes = [],
}: UsePromotionsArgs): UsePromotionsResult {
  const [quotes, setQuotes] = useState<PromotedQuote[]>(initialQuotes);
  const [hint, setHint] = useState<string | null>(null);
  // Per-id guard for removals — no double-delete.
  const removingIdsRef = useRef<Set<number>>(new Set());
  // Mirror the latest quotes so ``removePromotion`` can look up the row it drops
  // (for revert-on-error) without depending on ``quotes`` — that keeps its
  // identity stable across every add/remove.
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  // ``'snapshot'``: on reopen the fetched server copy wins an id collision — the
  // hook's original semantics, preserved so this dedup stays behaviour-neutral.
  useHydrateOnOpen(entryId, listPromotions, setQuotes, byAnchorThenId, setHint, 'snapshot');
  const { promote, retryPromote, promoting, promoted, clearRetry } = usePromoteAction(
    entryId,
    setQuotes,
    setHint,
  );

  const removePromotion = useCallback(
    (id: number): Promise<void> =>
      optimisticRemove(id, {
        pendingIds: removingIdsRef.current,
        current: quotesRef.current,
        setItems: setQuotes,
        removeRemote: promotions.remove,
        reinsert: insertSorted,
        onError: setHint,
        // Drop any pending promote retry: a remove failure surfaces its own
        // notice, and a promote "Try again" beside it would be mis-contexted.
        beforeStart: () => {
          setHint(null);
          clearRetry();
        },
      }),
    [clearRetry],
  );

  return { quotes, hint, promote, removePromotion, promoting, promoted, retryPromote };
}
