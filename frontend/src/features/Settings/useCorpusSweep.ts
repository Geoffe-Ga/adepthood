import { create } from 'zustand';

import { corpus, type CorpusSweepResult } from '@/api';
import { captureAuthScope, isAuthScopeCurrent } from '@/api/sessionToken';
import { registerStoreReset } from '@/store/registry';

/**
 * How much of this account's writing is still unsorted, shared by the Settings
 * hub row and the sort-the-rest screen (#3499).
 *
 * One store rather than two reads so the hub row, which hides at zero, learns
 * what the screen's last pass left without asking the server again: a person
 * who sorts the last entry and comes back sees the row gone, and one who sorted
 * nothing sees the same remainder they were just shown.
 *
 * ``null`` is "not known": never asked, still in flight, or the read failed. The
 * hub treats unknown as nothing to offer -- a control that may do nothing is not
 * shown -- and the screen says the count did not load.
 *
 * Every answer is bound to the account and session it was asked under, and the
 * store is cleared on every account boundary, so one account's backlog never
 * renders on another's hub.
 */

/** The one source a sweep sorts: what somebody writes in the app. */
export const CORPUS_SWEEP_SOURCE = 'journal';

interface SweepState {
  pending: number | null;
  /**
   * The journal page's offer (#3500) was set aside -- "Not now", or opened --
   * this session. Session-scoped on purpose: the offer is not asked again on
   * the next page opened, but a later session may ask once more. "Do not ask
   * again" is kept on the device instead (``corpusSweepOfferStorage``).
   */
  offerSetAside: boolean;
}

const useSweepState = create<SweepState>(() => ({ pending: null, offerSetAside: false }));
let generation = 0;

registerStoreReset(() => {
  generation += 1;
  useSweepState.setState({ pending: null, offerSetAside: false });
});

/** Whether work begun now may still land when it finishes. */
function captureWrite(): () => boolean {
  const epoch = generation;
  const scope = captureAuthScope();
  return () => generation === epoch && isAuthScopeCurrent(scope);
}

/**
 * Ask the server how much is unsorted. Resolves ``true`` when a count landed,
 * ``false`` when the read failed or its answer arrived for an account no
 * longer on the device. A failed read makes the count unknown rather than
 * leaving an older one standing, so the hub never offers a backlog it cannot
 * vouch for.
 */
export async function refreshSweepEstimate(): Promise<boolean> {
  const current = captureWrite();
  try {
    const estimate = await corpus.sweepEstimate();
    if (!current()) return false;
    useSweepState.setState({ pending: estimate.entries_pending });
    return true;
  } catch {
    if (current()) useSweepState.setState({ pending: null });
    return false;
  }
}

/**
 * Run one bounded pass and publish what it left. Rejects with whatever the
 * request rejected with (a ``429`` included), so the screen can say which.
 * Resolves ``null`` when the answer arrived for an account no longer here.
 */
export async function runSweepPass(): Promise<CorpusSweepResult | null> {
  const current = captureWrite();
  const result = await corpus.sweep();
  if (!current()) return null;
  useSweepState.setState({ pending: result.entries_remaining });
  return result;
}

/** The unsorted count as last known, or ``null`` when it is not known. */
export function useCorpusSweepPending(): number | null {
  return useSweepState((state) => state.pending);
}

/** Set the journal page's sweep offer aside for the rest of this session. */
export function setSweepOfferAside(): void {
  useSweepState.setState({ offerSetAside: true });
}

/** Whether the journal page's sweep offer has been set aside this session. */
export function isSweepOfferSetAside(): boolean {
  return useSweepState.getState().offerSetAside;
}

/** The same, as a subscription, so a decline on one mount hides every other. */
export function useSweepOfferSetAside(): boolean {
  return useSweepState((state) => state.offerSetAside);
}
