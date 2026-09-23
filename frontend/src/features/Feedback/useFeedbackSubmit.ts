/**
 * Sending a report: one request per press, never more, and never on its own.
 *
 * - An in-flight guard (a ref, so it holds within one render) turns a double
 *   tap into one call.
 * - A frozen attempt is resent byte for byte under its own key; a live draft is
 *   sent under the draft's key. Either way the key was persisted before Send
 *   could be pressed.
 * - The draft is cleared only after `feedback.submit` resolved -- which means
 *   the receipt already passed `feedbackReceiptSchema`. Every failure keeps it.
 * - Nothing here retries. The request layer's own keyed retry is the only
 *   automatic resend, and after it gives up the next send is the person's call.
 */
import { useCallback, useReducer, useRef } from 'react';

import {
  classifySubmitFailure,
  isAmbiguousFailure,
  type FeedbackFailureKind,
} from './feedbackOutcome';
import type { FeedbackDraftApi } from './useFeedbackDraft';

import { feedback, type FeedbackCreate, type FeedbackReceipt } from '@/api';

export type FeedbackSubmitState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; receipt: FeedbackReceipt }
  | { status: 'failed'; kind: FeedbackFailureKind };

type Action =
  | { type: 'send' }
  | { type: 'sent'; receipt: FeedbackReceipt }
  | { type: 'failed'; kind: FeedbackFailureKind }
  | { type: 'reset' };

function reducer(_state: FeedbackSubmitState, action: Action): FeedbackSubmitState {
  switch (action.type) {
    case 'send':
      return { status: 'sending' };
    case 'sent':
      return { status: 'sent', receipt: action.receipt };
    case 'failed':
      return { status: 'failed', kind: action.kind };
    default:
      return { status: 'idle' };
  }
}

export interface FeedbackSubmitApi {
  state: FeedbackSubmitState;
  /**
   * Send the frozen attempt when there is one -- whatever the live draft now
   * says -- and otherwise `livePayload`. This hook is the one place that choice
   * is made.
   */
  send: (livePayload: FeedbackCreate | null) => Promise<void>;
  /** Forget a shown failure (after the person edits again). */
  reset: () => void;
}

export function useFeedbackSubmit(draftApi: FeedbackDraftApi): FeedbackSubmitApi {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' });
  const inFlight = useRef(false);
  const { draft, freezeAttempt, clear } = draftApi;

  const send = useCallback(
    async (livePayload: FeedbackCreate | null): Promise<void> => {
      const frozen = draft.attempt;
      const payload = frozen?.payload ?? livePayload;
      if (inFlight.current || payload === null) return;
      inFlight.current = true;
      const key = frozen?.key ?? draft.idempotencyKey;
      dispatch({ type: 'send' });
      try {
        const receipt = await feedback.submit(payload, key);
        await clear();
        dispatch({ type: 'sent', receipt });
      } catch (error: unknown) {
        const kind = classifySubmitFailure(error);
        if (isAmbiguousFailure(kind) && frozen === null) await freezeAttempt(payload);
        dispatch({ type: 'failed', kind });
      } finally {
        inFlight.current = false;
      }
    },
    [draft.attempt, draft.idempotencyKey, freezeAttempt, clear],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, send, reset };
}
