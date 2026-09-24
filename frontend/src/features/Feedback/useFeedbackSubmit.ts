/**
 * Sending a report: one request per press, never more, and never on its own.
 *
 * - An in-flight guard (a ref, so it holds within one render) turns a double
 *   tap into one call.
 * - The attempt -- payload and key -- is written to storage BEFORE the request
 *   leaves (awaited). A composer closed mid-send, or an app killed mid-send,
 *   therefore reopens on "Send again" with the same bytes under the same key,
 *   never on an editable draft whose edits the server would silently replace
 *   with the report it already stored under that key.
 * - The attempt stays frozen through every failure except `invalid`. The server
 *   replays by key without comparing bodies, and the request layer retries a
 *   keyed POST (429 included) and reports only its LAST error, so a 429, a 401
 *   or a timeout can all follow an earlier attempt that was stored. An unchanged
 *   resend is always safe; an edit is offered only through "Edit report", which
 *   mints a new key and says so. `invalid` (422 and other body refusals) is the
 *   one definitive outcome: body validation runs before the key is looked up and
 *   gives every retry of the same body the same answer, so nothing was stored
 *   and the draft is safe to edit under the same key.
 * - The draft is removed only after `feedback.submit` resolved -- which means
 *   the receipt already passed `feedbackReceiptSchema`.
 * - Nothing here retries. The request layer's own keyed retry is the only
 *   automatic resend, and after it gives up the next send is the person's call.
 */
import { useCallback, useReducer, useRef } from 'react';

import {
  classifySubmitFailure,
  isDefinitiveRefusal,
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
  const { draft, freezeAttempt, settleAttempt } = draftApi;

  const send = useCallback(
    async (livePayload: FeedbackCreate | null): Promise<void> => {
      const frozen = draft.attempt;
      const payload = frozen?.payload ?? livePayload;
      const key = frozen?.key ?? draft.idempotencyKey;
      if (inFlight.current || payload === null) return;
      inFlight.current = true;
      dispatch({ type: 'send' });
      try {
        if (frozen === null) await freezeAttempt(payload);
        const receipt = await feedback.submit(payload, key);
        await settleAttempt(key, 'sent');
        dispatch({ type: 'sent', receipt });
      } catch (error: unknown) {
        const kind = classifySubmitFailure(error);
        if (isDefinitiveRefusal(kind)) await settleAttempt(key, 'unfreeze');
        dispatch({ type: 'failed', kind });
      } finally {
        inFlight.current = false;
      }
    },
    [draft.attempt, draft.idempotencyKey, freezeAttempt, settleAttempt],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, send, reset };
}
