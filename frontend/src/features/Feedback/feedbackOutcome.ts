/**
 * What a failed send means for the person holding the draft.
 *
 * The intake route replays a stored report by idempotency key WITHOUT comparing
 * the body (`backend/src/routers/feedback.py`). That makes one question decide
 * everything here: could the report already be on the server?
 *
 * - `retryable` -- the network dropped, the request timed out, or the server
 *   answered 408/5xx. The report may have been stored, so the attempt is frozen
 *   and "Send again" resends the identical payload under the same key. It is
 *   safe, and it will not create a duplicate.
 * - `unexpected` -- the server answered 2xx but the receipt did not validate.
 *   It almost certainly WAS stored, so this freezes too.
 * - `rate_limited` / `invalid` -- a 429 or a 4xx refusal happens before any row
 *   is written, so the draft stays editable under the same key.
 * - `session` -- a 401/403: the session ended; nothing was stored.
 */
import { ApiError, ApiTimeoutError, ApiValidationError } from '@/api';

export type FeedbackFailureKind =
  'retryable' | 'unexpected' | 'rate_limited' | 'invalid' | 'session';

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR_MIN = 500;

function classifyStatus(status: number): FeedbackFailureKind {
  if (status === HTTP_TOO_MANY_REQUESTS) return 'rate_limited';
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'session';
  if (status === HTTP_REQUEST_TIMEOUT || status >= HTTP_SERVER_ERROR_MIN) return 'retryable';
  return 'invalid';
}

/** Classify whatever `feedback.submit` rejected with. */
export function classifySubmitFailure(error: unknown): FeedbackFailureKind {
  if (error instanceof ApiValidationError) return 'unexpected';
  if (error instanceof ApiTimeoutError) return 'retryable';
  if (error instanceof ApiError) return classifyStatus(error.status);
  // A TypeError from fetch ("Network request failed"), an AbortError, or
  // anything else thrown below the HTTP layer: the request may have landed.
  return 'retryable';
}

/** Whether a failure of this kind means the report might already be stored. */
export function isAmbiguousFailure(kind: FeedbackFailureKind): boolean {
  return kind === 'retryable' || kind === 'unexpected';
}

/**
 * The words for each outcome. None of them promises a response time, and each
 * says what happened to the draft.
 */
export const FEEDBACK_OUTCOME_COPY: Readonly<Record<FeedbackFailureKind, string>> = {
  retryable:
    "We couldn't confirm your report arrived. It's safe to send again — it will not create a duplicate.",
  unexpected:
    "Your report may have reached us, but we couldn't read the confirmation. It's safe to send again — it will not create a duplicate.",
  rate_limited:
    "You've sent several reports in a short time. Your draft is saved here — please try again later.",
  invalid:
    "Part of this report couldn't be accepted. Your draft is still here — check it and send again.",
  session: 'Your session has ended, so this report was not sent. Sign in again to send feedback.',
};

export const FEEDBACK_SUCCESS_COPY = {
  heading: 'Thank you — your report was sent.',
  reference: 'Your reference is',
  keep: 'Keep this reference if you want to mention this report later.',
} as const;

export const FEEDBACK_EDIT_AFTER_FAILURE_COPY =
  'If the earlier send reached us, sending an edited report will file a second one.';
