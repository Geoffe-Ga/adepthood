/**
 * ``inclusionMark`` — what one inclusion mark (``PATCH /promotions/{id}``) came
 * to, for the composer's per-quote retry ledger (#2754). No React, no I/O.
 *
 * A mark either landed (``'marked'``), failed in a way a later retry can mend
 * (``'failed'``: offline, a 5xx, a 403, a refused target), or found the quote
 * itself gone (``'gone'``): deleted on the Promoted quotes screen while the
 * composer sat behind it. A gone quote has left the pending set, so it retires
 * from the retry warning rather than holding it up forever, and a retry never
 * marks -- or splices -- it again.
 */

/** A settled inclusion mark: landed, worth retrying, or its quote no longer exists. */
export type MarkOutcome = 'marked' | 'failed' | 'gone';

/**
 * The status the promotions PATCH answers when the quote is missing, deleted or
 * someone else's (``backend/src/routers/promotions.py`` ``update_promotion``).
 */
export const QUOTE_GONE_STATUS = 404;

/**
 * The detail that pins that 404 on the QUOTE. The same PATCH also answers 404
 * ``journal_entry_not_found`` when the review entry it targets is gone -- then
 * the quote still exists and is still pending, so it must NOT retire.
 */
export const QUOTE_GONE_DETAIL = 'promotion_not_found';

/**
 * Classify a rejected mark. Structural rather than ``instanceof ApiError``,
 * following ``extractStatus`` in ``api/errorMessages.ts``: a status is read off
 * whatever was thrown, so a test double that omits ``ApiError`` cannot make the
 * check itself throw. Only the exact numeric status AND detail count as gone;
 * everything else stays on the retry list.
 */
export function classifyMarkFailure(err: unknown): Exclude<MarkOutcome, 'marked'> {
  if (typeof err !== 'object' || err === null) return 'failed';
  const { status, detail } = err as { status?: unknown; detail?: unknown };
  return status === QUOTE_GONE_STATUS && detail === QUOTE_GONE_DETAIL ? 'gone' : 'failed';
}
