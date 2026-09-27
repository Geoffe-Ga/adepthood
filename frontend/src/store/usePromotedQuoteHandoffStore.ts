/**
 * The hand-off seam between the Promoted quotes screen and the review that
 * folds a selection in (#2885).
 *
 * Two ways in, one way through:
 *
 * - Opened from a review being written, the entry mints a token and carries it
 *   on the ``PromotedQuotes`` route (``injectInto``). "Fold N quotes into this
 *   review" delivers the checked quotes under that token and goes back; the
 *   entry, still mounted beneath, collects them.
 * - Opened anywhere else, "Write a review with N quotes" opens the review
 *   picker; the SCREEN mints the token, delivers under it, and opens the chosen
 *   review with it on the ``JournalEntry`` route (``injectQuotes``). The review
 *   collects once it has hydrated.
 *
 * PRIVACY, as with the photographed page: the quoted words live here in memory
 * only, for the one hop. They never ride in navigation params (which persist
 * in navigation state for the life of the stack) -- only the opaque token does
 * -- the delivery is retracted the moment it is collected, and
 * ``registerStoreReset`` wipes it at logout.
 *
 * Deliveries are ADDRESSED: every mounted entry watches this store, and each
 * collects only the delivery bearing its own token.
 */
import { create } from 'zustand';

import { registerStoreReset } from './registry';

import type { FoldCandidate } from '@/features/Journal/quoteBatch';

/** A selection waiting to be folded in, and the hand-off it belongs to. */
export interface PendingQuoteHandoff {
  token: string;
  /** The checked quotes, in the order they are to be folded in. */
  candidates: readonly FoldCandidate[];
}

export interface PromotedQuoteHandoffState {
  /** How many hand-offs have been opened; the source of each token's number. */
  issued: number;
  pending: PendingQuoteHandoff | null;
  /** Begin a hand-off and return its token, dropping any uncollected delivery. */
  open: () => string;
  /** Publish ``candidates`` to the hand-off opened under ``token``. */
  deliver: (_token: string, _candidates: readonly FoldCandidate[]) => void;
  /** Retract the pending delivery, so it is collected exactly once. */
  clear: () => void;
}

/** Token prefix; the number after it is the hand-off's ordinal in this session. */
const TOKEN_PREFIX = 'quotes-';

export const usePromotedQuoteHandoffStore = create<PromotedQuoteHandoffState>((set, get) => ({
  issued: 0,
  pending: null,

  open: () => {
    const issued = get().issued + 1;
    set({ issued, pending: null });
    return `${TOKEN_PREFIX}${issued}`;
  },
  deliver: (token, candidates) => {
    set({ pending: { token, candidates } });
  },
  clear: () => {
    set({ pending: null });
  },
}));

registerStoreReset(() => {
  usePromotedQuoteHandoffStore.getState().clear();
});
