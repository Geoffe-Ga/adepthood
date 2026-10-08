import type { CopyLocation, JournalErasureReceipt } from '@/api';

/**
 * The words the journal uses when somebody unwrites one of their own pages.
 *
 * Deleting your own writing is an ordinary act, so nothing here scolds, warns
 * darkly, or argues the person out of it. Nor does it overclaim in either
 * direction: the row survives server-side inside a retention window, and the
 * app offers no way to bring it back, so what is promised is exactly what the
 * app can keep — gone from here, with the corpus copy it fed withdrawn too.
 */

export const DELETE_ENTRY_TITLE = 'Delete this page?';

/**
 * Two true things, in the order they matter: where the page goes, and how far
 * that reaches. The second clause is the ontologized-corpus withdrawal said
 * quietly — deleting a page stops that writing being retrieved as context.
 */
export const DELETE_ENTRY_BODY =
  'It leaves your journal, and the copy your reflections draw on goes with it. Its copy in a connected Creek vault is removed too. ' +
  'If that vault is offline, the page stays on your shelf so you can try again. ' +
  'There is no way back to it from inside the app.';

export const DELETE_ENTRY_CONFIRM = 'Delete';
export const DELETE_ENTRY_CANCEL = 'Cancel';

/** Accessible name for a shelf row's delete affordance. */
export function deleteEntryLabel(title: string): string {
  return `Delete ${title} entry`;
}

/** A refused delete: say what is still true, then pass on the reason. */
export function deleteEntryFailureNotice(detail: string): string {
  return `That page is still on your shelf — we could not delete it. ${detail}`;
}

// --- A copy the vault has not confirmed gone (#3094) -------------------------
// DRAFT copy, pending owner review. Each line is a strict narrowing: nothing
// here says a vault copy is gone unless that vault confirmed it.

/** The 503 details that mean "the page is safe here, its vault copy is not confirmed". */
export const WITHDRAWAL_PENDING_LOCATIONS: Readonly<Record<string, CopyLocation>> = {
  vault_withdrawal_pending: 'connected_vault',
  vault_withdrawal_previous_vault: 'previous_vault',
  vault_withdrawal_disconnected_vault: 'disconnected_vault',
};

/** Reconnect first: the primary way out. */
export const UNREACHABLE_RECONNECT_LABEL = 'Reconnect vault';

/** The "I can't reach it" way out. */
export const UNREACHABLE_ERASE_LABEL = "I can't reach it — delete here only";

/** What deleting here only does, said before the person chooses it. */
export const UNREACHABLE_ERASE_EXPLAINER =
  "Deleting here only removes this page from Adepthood. We can't confirm the copy in that vault is gone, so you would need to delete it there yourself.";

/** Where a copy may remain, in terms the person already knows. */
const PLACE: Readonly<Record<CopyLocation, string>> = {
  connected_vault: 'your Creek vault',
  previous_vault: 'the Creek vault you were connected to before',
  disconnected_vault: 'the Creek vault you disconnected',
};

/** The receipt after deleting here only: plain, and never "withdrawn" unless confirmed. */
export function erasureReceiptNotice(receipt: JournalErasureReceipt): string {
  if (receipt.remote_copy === 'confirmed_absent') {
    return 'Deleted. Your Creek vault confirmed its copy is gone too.';
  }
  const place = PLACE[receipt.copy_location ?? 'connected_vault'];
  return `Deleted from Adepthood. A copy may still be in ${place}. We couldn't confirm it's gone, so please delete it there.`;
}
