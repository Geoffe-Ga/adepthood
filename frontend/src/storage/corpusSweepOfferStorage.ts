import { readOwnedDecline, writeOwnedDeclineKey } from './declineOwnership';
import { scopedKey } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';
/**
 * Persists "Do not ask again" on the journal page's offer to sort the rest of
 * the writing (#3500).
 *
 * The consent invitation keeps its declines on the server (``PUT
 * /corpus/invitation``), because its offer rule lives there. The sweep offer
 * has no server rule and no server record -- the shipped ``/corpus/sweep``
 * routes count and sort, nothing more -- so this decline is device-local and
 * account-scoped, like the link-a-habit note's, and says nothing about consent:
 * it is a decision about being *asked*.
 *
 * Unlike that note this one fails CLOSED on a read error. Its contract is that
 * any error renders nothing, and the full offer is always one tap away in
 * Settings, so a flaky disk costs at most a missed nudge -- never a repeat of
 * a question somebody already declined for good.
 */

export const CORPUS_SWEEP_OFFER_NEVER_KEY = '@adepthood/corpus_sweep_offer_never';
const FLAG_TRUE = 'true';

/** Whether this account has asked never to be offered the sweep on the journal page. */
export async function loadCorpusSweepOfferDeclined(): Promise<boolean> {
  try {
    return (await readOwnedDecline(CORPUS_SWEEP_OFFER_NEVER_KEY)) === FLAG_TRUE;
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'corpus_sweep_offer' });
    return true;
  }
}

/**
 * "Do not ask again". Never rejects: the note is already gone in memory and the
 * caller fires this and forgets, so a failed write is reported here. Resolves
 * whether it was saved.
 */
export async function saveCorpusSweepOfferDeclined(): Promise<boolean> {
  try {
    await writeOwnedDeclineKey(scopedKey(CORPUS_SWEEP_OFFER_NEVER_KEY), FLAG_TRUE);
    return true;
  } catch {
    reportDiagnostic('storage_write_failed', { storage: 'corpus_sweep_offer' });
    return false;
  }
}
