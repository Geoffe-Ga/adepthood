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
  'Deletion is requested here and for the copy your reflections draw on. Removal of earlier Creek vault copies is requested too; they may remain until the vault confirms. ' +
  'While that removal is pending, the page stays on your shelf and cannot be edited. Adepthood automatically retries when the recorded vault is reachable. ' +
  'There is no way back to it from inside the app.';

/** Only a DELETE refusal establishes a recorded deletion and its editing lock. */
export function deleteEntryPendingNotice(detail: string): string {
  return `This page is set to be deleted and cannot be edited. ${detail}`;
}

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

/** The 409 a page answers to any edit while its deletion is in progress (#3098). */
export const DELETION_PENDING_DETAIL = 'journal_entry_deletion_pending';

/** The 503 details that mean "deletion is recorded; its vault copy is not confirmed yet". */
export const WITHDRAWAL_PENDING_LOCATIONS: Readonly<Record<string, CopyLocation>> = {
  vault_withdrawal_pending: 'connected_vault',
  vault_withdrawal_previous_vault: 'previous_vault',
  vault_withdrawal_disconnected_vault: 'disconnected_vault',
  vault_withdrawal_unrecorded_vault: 'unrecorded_vault',
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
  unrecorded_vault: 'a Creek vault you connected earlier',
};

/**
 * When Adepthood began recording which vault received each copy (#3095). A
 * copy made before then can never be confirmed gone by any vault.
 */
export const VAULT_BINDING_BEGAN = 'October 7, 2026';

/**
 * Said when "delete here only" finds the page already deleted (the background
 * finished it). Claims nothing about the vault copy: a 404 cannot tell.
 */
export const ALREADY_DELETED_NOTICE = 'This page was already deleted.';

/** The receipt after deleting here only: plain, and never "withdrawn" unless confirmed. */
export function erasureReceiptNotice(receipt: JournalErasureReceipt): string {
  if (receipt.remote_copy === 'confirmed_absent') {
    return 'Deleted. Your Creek vault confirmed its copy is gone too.';
  }
  if (receipt.copy_location === 'unrecorded_vault') {
    return `Deleted from Adepthood. This page was copied to a Creek vault before ${VAULT_BINDING_BEGAN}, before we recorded which vault received it, so a copy may still be in ${PLACE.unrecorded_vault}. We can't confirm it's gone, so please delete it there.`;
  }
  const place = PLACE[receipt.copy_location ?? 'connected_vault'];
  return `Deleted from Adepthood. A copy may still be in ${place}. We couldn't confirm it's gone, so please delete it there.`;
}
