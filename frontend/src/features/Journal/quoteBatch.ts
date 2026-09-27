/**
 * ``quoteBatch`` — the pure half of folding several promoted quotes into a
 * review at once (#2885). No React, no I/O.
 *
 * A selection is folded as ONE body change: every block the body does not
 * already hold is spliced at the caret, in the order given, one blank line
 * apart, with the caret walking forward past each so the next lands after it.
 *
 * The duplicate rule, stated once: the body is the record of what is folded in.
 * A candidate whose rendered block the running text already contains -- because
 * an earlier fold put it there, or because an earlier candidate in THIS batch
 * rendered to the same block (two quotes of identical words from one source) --
 * is not spliced again. It is still marked included by the caller: the words it
 * quotes are in the review, which is all "included" claims.
 */
import { formatBlockquote, quoteAttribution, spliceQuoteBlock } from './reflectionCopy';

import type { PromotedQuoteListItem, PromotedQuoteSummary, ReflectionSourceItem } from '@/api';

/** One quote ready to fold in: its id, its words, and the line naming its source. */
export interface FoldCandidate {
  id: number;
  anchorText: string;
  attribution: string;
}

/** What a batch splice will write, and which candidates it actually wrote. */
export interface QuoteBatchPlan {
  text: string;
  /** Just past the last block written; the incoming caret when nothing was. */
  nextCaret: number | null;
  /** The ids whose block this plan wrote, in the order written. */
  spliced: number[];
}

/** A candidate from the sources panel: a feed quote and the source it came from. */
export function candidateFromSource(
  quote: PromotedQuoteSummary,
  item: ReflectionSourceItem,
): FoldCandidate {
  return { id: quote.id, anchorText: quote.anchor_text, attribution: quoteAttribution(item) };
}

/** A candidate from the Promoted quotes screen, attributed exactly as the panel would. */
export function candidateFromListItem(quote: PromotedQuoteListItem): FoldCandidate {
  return {
    id: quote.id,
    anchorText: quote.anchor_text,
    attribution: quoteAttribution({ title: quote.source_title, timestamp: quote.source_timestamp }),
  };
}

/**
 * The order the Promoted quotes screen folds a selection in: the oldest source
 * first, then where each passage sits within its source, then id. That is the
 * sources panel's own order (sources oldest first, each source's quotes by
 * anchor), so the same pair lands the same way round from either surface --
 * not the screen's display order, which is newest-promoted first.
 */
export function byPassageOrder(a: PromotedQuoteListItem, b: PromotedQuoteListItem): number {
  const bySource = Date.parse(a.source_timestamp) - Date.parse(b.source_timestamp);
  return bySource || a.anchor_start - b.anchor_start || a.id - b.id;
}

/** Splice every candidate the body does not already hold, at ``caret``, in order. */
export function planQuoteBatch(
  body: string,
  candidates: readonly FoldCandidate[],
  caret: number | null,
): QuoteBatchPlan {
  let text = body;
  let at = caret;
  const spliced: number[] = [];
  for (const candidate of candidates) {
    const block = formatBlockquote(candidate.anchorText, candidate.attribution);
    if (text.includes(block)) continue;
    const next = spliceQuoteBlock(text, block, at);
    text = next.text;
    at = next.nextCaret;
    spliced.push(candidate.id);
  }
  return { text, nextCaret: at, spliced };
}
