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
  'It leaves your journal, and the copy your reflections draw on goes with it. ' +
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
