/**
 * ``usePromotedQuoteHandoff`` — the review's half of the Promoted quotes
 * hand-off (#2885; the screen's half is ``PromotedQuotesFold``).
 *
 * A review page collects a selection delivered under one of two tokens: the
 * one it minted when its drawer opened the screen (``mint``), or the one the
 * screen put on its own route when it opened this review for the quotes
 * (``routeToken``). Any other delivery belongs to another mounted page and is
 * left alone.
 *
 * It collects only while ``ready`` -- composing a review, hydrated, and
 * editable -- so a review continued by id folds the quotes into the body it
 * loaded rather than into the empty one it began with, and a finished review
 * waits for the writer to choose to edit it rather than being edited behind
 * its edit gate. Collection retracts the delivery BEFORE folding, so no
 * re-render can fold the same selection twice.
 */
import { useCallback, useEffect, useRef } from 'react';

import type { FoldCandidate } from './quoteBatch';

import { usePromotedQuoteHandoffStore } from '@/store/usePromotedQuoteHandoffStore';

export interface PromotedQuoteHandoffArgs {
  /** True once the page can fold: a hydrated, editable review. */
  ready: boolean;
  /** The token on this page's own route, from "Write a review with N quotes". */
  routeToken?: string;
  onInsertQuotes: (_candidates: readonly FoldCandidate[]) => Promise<unknown>;
}

export function usePromotedQuoteHandoff({
  ready,
  routeToken,
  onInsertQuotes,
}: PromotedQuoteHandoffArgs): { mint: () => string } {
  const pending = usePromotedQuoteHandoffStore((store) => store.pending);
  const open = usePromotedQuoteHandoffStore((store) => store.open);
  const clear = usePromotedQuoteHandoffStore((store) => store.clear);
  const tokenRef = useRef<string | null>(null);

  const mint = useCallback(() => {
    tokenRef.current = open();
    return tokenRef.current;
  }, [open]);

  useEffect(() => {
    if (pending == null || !ready) return;
    if (pending.token !== tokenRef.current && pending.token !== routeToken) return;
    clear();
    void onInsertQuotes(pending.candidates);
  }, [pending, ready, routeToken, clear, onInsertQuotes]);

  return { mint };
}
