/**
 * The resonance spend-disclosure stand-in for the ``JournalEntryScreen`` specs.
 *
 * "Get Resonance" charges — one BotMason message per pass — so the screen puts
 * ``ResonanceExplainerDialog`` in front of the first press. The specs below this
 * kit are about what happens *after* a pass (care notes, Creek context,
 * suggestions, the no-notes line), so they render as a reader who has already
 * read that note and asked not to see it again: the press goes straight through
 * and the spec stays about its own subject.
 *
 * Swapped in with
 * ``jest.mock('@/storage/resonanceExplainerStorage', () => require('./resonanceExplainerTestKit'))``.
 * The gate itself — that the note appears at all, that nothing is charged behind
 * it, and that the dismissal persists per account — is covered by
 * ``JournalEntryScreenResonanceExplainer.test.tsx`` and
 * ``storage/__tests__/resonanceExplainerStorage.test.ts``, which do NOT use this
 * kit.
 */

/** Reads as "this account already dismissed the cost note". */
export function loadResonanceExplainerDismissed(): Promise<boolean> {
  return Promise.resolve(true);
}

/** Nothing to persist: these specs never open the note. */
export function saveResonanceExplainerDismissed(): Promise<void> {
  return Promise.resolve();
}
