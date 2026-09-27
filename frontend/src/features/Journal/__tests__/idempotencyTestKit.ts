/**
 * What a keyed write looks like to the ``journal.create`` / ``prompts.respond``
 * mocks in the ``JournalEntryScreen`` specs (#2936).
 *
 * Every create of a page, and every answer to its weekly prompt, is sent under
 * the page's idempotency key. The key is a uuid minted per page, so a spec that
 * pins a call's arguments pins that *a* key rode along, not which one; the specs
 * that care which one (``JournalEntryScreenSaveRetry``) compare keys directly.
 */
import { expect } from '@jest/globals';

/** The options argument of a keyed ``journal.create``; spread into a respond's options. */
export const KEYED = { idempotencyKey: expect.any(String) };
