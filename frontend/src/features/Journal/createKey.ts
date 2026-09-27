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
 * returns the row as FIRST written — or as it has since been edited elsewhere —
 * so a resent create cannot treat the text it just sent as stored. What it may
 * write back is only what changed HERE since the first attempt, which is why the
 * first attempt's payload is held beside the key and handed back on every claim.
 * An attempt counter decides "resent" rather than a comparison of texts, because
 * the server sanitizes what it stores and a first-try create would otherwise
 * look like drift and write twice.
 */
import { v4 as uuidv4 } from 'uuid';

/**
 * One logical create: its key, how many attempts have been made under it, and
 * what the first attempt carried (``T``, whatever the caller records).
 */
export interface CreateKey<T = unknown> {
  readonly key: string;
  attempts: number;
  readonly first: T;
}

/** Where a caller holds its create's key between attempts. */
export interface CreateKeyRef<T = unknown> {
  current: CreateKey<T> | null;
}

/**
 * One claimed attempt: the key to send, whether an earlier attempt was made, and
 * the payload the FIRST attempt carried (this one's own, on a first claim).
 */
export interface CreateAttempt<T = unknown> {
  key: string;
  resent: boolean;
  first: T;
}

/**
 * Claim the next attempt of this create: mint its key on the first claim and
 * record ``sending`` as what the first attempt carried; keep both on every later
 * claim, and report whether any attempt preceded this one.
 */
export function claimCreateAttempt<T>(ref: CreateKeyRef<T>, sending: T): CreateAttempt<T> {
  ref.current ??= { key: uuidv4(), attempts: 0, first: sending };
  ref.current.attempts += 1;
  const { key, attempts, first } = ref.current;
  return { key, resent: attempts > 1, first };
}
