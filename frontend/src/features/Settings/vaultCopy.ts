/**
 * Copy for the "Your private vault" Settings surface.
 *
 * A private vault is an optional depth, not a missing piece. Adepthood commits
 * every entry to its own store before a vault is ever contacted, replication is
 * best-effort, and a deployment with no vault at all is fully supported — so
 * every line here describes a vault as something that only ever holds a copy,
 * and none of it frames going without one as a lesser state.
 *
 * The strings are kept in this module rather than inline so the guards in
 * ``__tests__/vaultCopy.test.ts`` can run over the copy itself: no technical,
 * host or routing vocabulary; no loss, risk or obligation framing; and no
 * durability claim the write path does not make.
 */

/** Hub row label. Names the destination without implying an action is pending. */
export const VAULT_ROW_LABEL = 'Private vault';

/**
 * Hub row description. States the offer and the floor together, so a user who
 * never opens the screen still learns that declining costs them nothing.
 */
export const VAULT_ROW_DESCRIPTION =
  'An optional copy of what you write, in a space you run yourself. Adepthood is complete without one.';

/** Header eyebrow. Sets the register before the title: this is a choice. */
export const VAULT_EYEBROW = 'Optional';

/** Screen and navigation title. Descriptive, not an instruction to connect. */
export const VAULT_TITLE = 'Your private vault';

/**
 * The one promise. It says ownership and choice in a single claim, and the
 * "as you choose" is load-bearing rather than a hedge: an entry marked Public
 * is shareable with the Sangha, so a flat "stays private" would be false for a
 * tier the writer themselves picked. Sovereignty is the promise the app keeps
 * at every setting, with or without a vault.
 */
export const VAULT_PROMISE = 'Your writing is yours, and it stays as private as you choose.';

/**
 * What a vault is. Says "sends a copy of each entry" rather than "a copy of
 * your journal": replication is attempted per entry and a failed one is dropped
 * rather than retried, so whole-journal phrasing would imply a completeness the
 * write path does not keep. The entry is already saved before any of this
 * happens, so it describes an addition and never a transfer.
 */
export const VAULT_WHAT_IT_IS =
  'A private vault is a space you run yourself. When one is connected, Adepthood sends a copy of each entry there as you write — into a place you hold.';

/**
 * The floor. Declining is a complete way to use Adepthood, so this says so
 * plainly and bounds what a vault changes: it adds a copy, and nothing else.
 */
export const VAULT_FLOOR =
  'Adepthood is complete without a vault. Your journal, your reflections, and everything you have written are all here either way. A vault adds a copy in your own space; nothing else changes.';

/**
 * The Intimate boundary. An entry marked Intimate stops before any vault is
 * contacted at all, so this is a statement of shipped behaviour, not intent.
 */
export const VAULT_INTIMATE = 'Entries you mark Intimate are never sent to a vault.';

/**
 * Where setup happens. The app has nothing to collect, and saying so directly
 * is what keeps the screen from reading as an unfinished form.
 */
export const VAULT_SETUP =
  'A vault is set up where it runs, not in the app — so there is nothing to fill in here.';
