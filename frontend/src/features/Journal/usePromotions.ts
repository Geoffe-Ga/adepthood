/**
 * ``usePromotions`` — owns the promoted-quote list for one source a reader can
 * promote from: their own entry, a Course chapter or a Resonance Letter
 * (select-a-span -> promote-quote; the source is a ``PromotionTarget``, #3660).
 *
 * ``promote`` raises a reader-selected span into the corpus and appends the
 * returned quote on success; a failure maps to a warm, non-blocking hint --
 * worded for the source the reader was quoting from -- and appends nothing.
 * ``removePromotion`` drops a quote optimistically and reverts it on error via
 * the shared optimistic-remove primitive. One promote runs at a time so a
 * double-tap can't double-post.
 */
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mergeByIdSorted, mergeSnapshotUnder, useHydrateOnOpen } from './entryList';
import { optimisticRemove } from './optimisticRemove';
import {
  LIST_PROMOTIONS,
  createPromotion,
  promotionTargetId,
  type PromotionTarget,
} from './promotionTarget';

import { promotions } from '@/api';
import type { PromotedQuote, PromotedQuoteSourceKind } from '@/api';
import { formatApiError, formatPromoteError } from '@/api/errorMessages';

export type { PromotionTarget } from './promotionTarget';

export interface UsePromotionsArgs {
  /** The source whose spans are being promoted (an entry, a chapter, a letter). */
  target: PromotionTarget;
  /** Quotes already promoted from this source (seeds the list). */
  initialQuotes?: PromotedQuote[];
  /**
   * Read the source's quotes on open (the default), so its highlights can be
   * drawn. A surface that draws none -- a Course chapter, whose rendered
   * Markdown carries no offsets -- passes false and spends no request on it.
   */
  hydrate?: boolean;
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
  /**
   * Re-read the entry's quotes from the server, whose copy wins. Called after an
   * edited entry saves: the PATCH re-anchored each pending quote (or marked it
   * stale), and the list held here still carries the pre-edit offsets. Never
   * rejects; a failure keeps the list and raises the usual content-free hint.
   */
  refresh: () => Promise<void>;
}

/** The list's canonical order: by anchor offset, then id as a stable tiebreak. */
function byAnchorThenId(a: PromotedQuote, b: PromotedQuote): number {
  return a.anchor_start - b.anchor_start || a.id - b.id;
}

/** Re-insert a quote, keeping the list ordered by anchor then id and deduped. */
function insertSorted(quotes: PromotedQuote[], quote: PromotedQuote): PromotedQuote[] {
  return mergeByIdSorted(quotes, [quote], byAnchorThenId);
}

/** The sentinel id for an unsaved entry: there is nothing on the server to re-read. */
const UNSAVED_ENTRY_ID = 0;

/** One source's identity across kinds: entry 9 and letter 9 are different sources. */
function sourceKey(kind: PromotedQuoteSourceKind, sourceId: number): string {
  return `${kind}:${String(sourceId)}`;
}

/**
 * Re-read one source's quotes, letting the server copy win every id collision.
 * ``sourceRef`` is the live source: a response for a source the screen has
 * since left is dropped rather than unioned into the new source's list.
 */
function useRefreshPromotions(
  kind: PromotedQuoteSourceKind,
  sourceId: number,
  setQuotes: Dispatch<SetStateAction<PromotedQuote[]>>,
  setHint: (_hint: string | null) => void,
): () => Promise<void> {
  const key = sourceKey(kind, sourceId);
  const sourceRef = useRef(key);
  sourceRef.current = key;
  return useCallback(async (): Promise<void> => {
    if (sourceId <= UNSAVED_ENTRY_ID) return;
    try {
      const { items } = await LIST_PROMOTIONS[kind](sourceId);
      if (sourceRef.current !== key) return;
      setQuotes(mergeSnapshotUnder(items, byAnchorThenId, 'snapshot'));
    } catch (err) {
      if (sourceRef.current === key) setHint(formatApiError(err));
    }
  }, [kind, sourceId, key, setQuotes, setHint]);
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
 * Own the promote lifecycle for one source: the single-flight ``create`` (never
 * throws — failures map to ``setHint``, worded for the source's kind), the
 * ``promoting``/``promoted`` render signals, and a ``retryPromote`` that
 * re-posts the last attempted span verbatim so a failure never loses the
 * reader's selection.
 */
function usePromoteAction(
  kind: PromotedQuoteSourceKind,
  sourceId: number,
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
        const span = { anchor_start: start, anchor_end: end };
        const created = await createPromotion(kind, sourceId, span);
        setQuotes((prev) => insertSorted(prev, created));
        setPromoted(true);
        setPromoteFailed(false);
      } catch (err) {
        setHint(formatPromoteError(err, kind));
        setPromoteFailed(true);
      } finally {
        promotingRef.current = false;
        setPromoting(false);
      }
    },
    [kind, sourceId, setQuotes, setHint],
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
  target,
  initialQuotes = [],
  hydrate = true,
}: UsePromotionsArgs): UsePromotionsResult {
  // Read as primitives: callers build ``target`` as a fresh literal each render.
  const { kind } = target;
  const sourceId = promotionTargetId(target);
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
  // The reader is chosen by kind, so a change of kind under the same id re-reads
  // (and resets) just as a change of id does.
  useHydrateOnOpen(
    hydrate ? sourceId : null,
    LIST_PROMOTIONS[kind],
    setQuotes,
    byAnchorThenId,
    setHint,
    'snapshot',
  );
  const { promote, retryPromote, promoting, promoted, clearRetry } = usePromoteAction(
    kind,
    sourceId,
    setQuotes,
    setHint,
  );
  const refresh = useRefreshPromotions(kind, sourceId, setQuotes, setHint);

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

  return { quotes, hint, promote, removePromotion, promoting, promoted, retryPromote, refresh };
}
