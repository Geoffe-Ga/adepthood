/**
 * The promote-explainer stand-in for the ``JournalEntryScreen`` promote specs.
 *
 * The first "Promote a quote" opens ``PromoteExplainerDialog`` before any
 * selection (#2864). The specs below this kit are about what happens *after* a
 * reader starts selecting — anchors, previews, errors, removal — so they render
 * as a reader who has already read that note and asked not to see it again:
 * the press goes straight to selecting and the spec stays about its own subject.
 *
 * Swapped in with
 * ``jest.mock('@/storage/promoteExplainerStorage', () => require('./promoteExplainerTestKit'))``.
 * The gate itself — that the note appears, what it says, and that the
 * dismissal persists per account — is covered by
 * ``JournalEntryScreenPromoteExplainer.test.tsx``, ``usePromoteExplainer.test.tsx``
 * and ``storage/__tests__/promoteExplainerStorage.test.ts``, which do NOT use
 * this kit.
 */

/** Reads as "this account already dismissed the promote note". */
export function loadPromoteExplainerDismissed(): Promise<boolean> {
  return Promise.resolve(true);
}

/** Nothing to persist: these specs never open the note. */
export function savePromoteExplainerDismissed(): Promise<void> {
  return Promise.resolve();
}
