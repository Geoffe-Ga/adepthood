/**
 * What saying yes to sorting gives somebody, held once and reused everywhere.
 *
 * The corpus-consent screen, the journal's invitation note, the vault screen,
 * managed-vault activation and the voice-readiness band all have reason to say
 * what the decision is for. One bounded line, held here, keeps them from drifting
 * into five different promises.
 *
 * **It says what the grounding code does, and nothing more.**
 * ``backend/src/services/higher_self_grounding.py`` gives one reflection a few
 * passages: from the sorted corpus when it holds anything, biased toward where
 * the reader stands in the course, and otherwise from their most recent other
 * entries -- never both, never an Intimate entry. So the line names a few
 * passages rather than everything, a possible leaning rather than a portrait,
 * and the recent-entries fallback it can reach beyond. The conditional also
 * covers ordinary states with no sorted passage or no course position.
 * ``__tests__/higherSelfCopy.test.ts`` bans every stronger claim by name and
 * checks any count against the published one.
 *
 * **It is the corpus decision, not a vault.** Connecting or creating a vault
 * turns no sorting on, so this line never says a vault gives it.
 */

/** The gain of saying yes to sorting, bounded by what one reflection reads. */
export const HIGHER_SELF_GAIN =
  'With sorting on, a reflection from your Higher Self can reach beyond your last few ' +
  'entries into what you have already written. When it draws from sorted writing, it uses ' +
  'a few passages at a time and can lean toward where you stand in the course, never using ' +
  'an Intimate one. Everything else you write here is sorted by Aspect.';

/** Every line this module owns, so a copy sweep can read them all. */
export const HIGHER_SELF_COPY_ENTRIES: readonly string[] = [HIGHER_SELF_GAIN];
