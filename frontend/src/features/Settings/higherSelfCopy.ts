/**
 * What saying yes to sorting gives somebody, said once and reused everywhere.
 *
 * The corpus-consent screen, the journal's invitation note, the vault screen,
 * managed-vault activation and the voice-readiness band all have reason to say
 * what the decision is for. One sentence, held here, keeps them from drifting
 * into five different promises.
 *
 * **It says what the grounding code does, and nothing more.**
 * ``backend/src/services/higher_self_grounding.py`` gives one reflection a few
 * passages: from the sorted corpus when it holds anything, biased toward where
 * the reader stands in the course, and otherwise from their most recent other
 * entries -- never both, never an Intimate entry. So the line names a few
 * passages rather than everything, a leaning rather than a portrait, and the
 * recent-entries default it replaces. ``__tests__/higherSelfCopy.test.ts`` bans
 * every stronger claim by name and checks any count against the published one.
 *
 * **It is the corpus decision, not a vault.** Connecting or creating a vault
 * turns no sorting on, so this line never says a vault gives it.
 */

/** The gain of saying yes to sorting, bounded by what one reflection reads. */
export const HIGHER_SELF_GAIN =
  'Say yes to sorting, and everything you write here, apart from Intimate entries and ' +
  'including what you have already written, is sorted by Aspect. Each reflection from your ' +
  'Higher Self can then draw on a few of those passages, leaning toward where you stand in ' +
  'the course, rather than only on your last few entries.';

/** Every line this module owns, so a copy sweep can read them all. */
export const HIGHER_SELF_COPY_ENTRIES: readonly string[] = [HIGHER_SELF_GAIN];
