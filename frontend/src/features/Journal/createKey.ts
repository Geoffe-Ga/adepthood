/**
 * The idempotency key for one logical create (#2936).
 *
 * A create whose answer is lost looks, from here, exactly like one that never
 * arrived, so both are retried the same way. Sending every attempt of one
 * logical create under one key lets the server answer a repeat with the entry
 * it already wrote instead of writing a second.
 *
 * The key is an *accumulating act's* key, not a transition's: it is minted once
 * when the first attempt is made (a uuid v4, as ``useFeedbackDraft`` mints its
 * own) and then held — across the autosave, the footer Retry, the reconnect
 * retry, Finish, and the transport's own retries — until the page has an id.
 * It is never derived from the payload, because the payload is exactly what
 * changes between attempts.
 *
 * ``resent`` is what tells the caller a replay may have answered. A replay
 * returns the row as FIRST written, so a resent create cannot treat the text it
 * just sent as stored: it must re-send the current body and tags. An attempt
 * counter decides that rather than a comparison of texts, because the server
 * sanitizes what it stores and a first-try create would otherwise look like
 * drift and write twice.
 */
import { v4 as uuidv4 } from 'uuid';

/** One logical create: its key, and how many attempts have been made under it. */
export interface CreateKey {
  readonly key: string;
  attempts: number;
}

/** Where a caller holds its create's key between attempts. */
export interface CreateKeyRef {
  current: CreateKey | null;
}

/** One claimed attempt: the key to send, and whether an earlier one was made. */
export interface CreateAttempt {
  key: string;
  resent: boolean;
}

/**
 * Claim the next attempt of this create: mint its key on the first claim, keep
 * it on every later one, and report whether any attempt preceded this one.
 */
export function claimCreateAttempt(ref: CreateKeyRef): CreateAttempt {
  ref.current ??= { key: uuidv4(), attempts: 0 };
  ref.current.attempts += 1;
  return { key: ref.current.key, resent: ref.current.attempts > 1 };
}
