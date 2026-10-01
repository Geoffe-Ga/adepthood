/**
 * Where the vault screen's "Learn how to run one" link goes.
 *
 * Kept out of ``vaultCopy.ts`` on purpose: that module's promise deck may not
 * spell a transport, and only three named form strings may say ``https``. A URL
 * is not copy, so it lives here, and the screen opens it only through
 * ``openExternalUrl``, which refuses anything that is not ``https``.
 *
 * The guide is the "Running your own vault" section of ``docs/your-data.md``,
 * served the same way as the legal documents (see ``legalLinks.ts``): read in
 * the platform browser from the repository's own web view, so it stays readable
 * on a day the API is not. ``__tests__/vaultLinks.test.ts`` computes GitHub's
 * slug for every heading in that file and fails if the anchor names none.
 */

/** The heading slug of "## Running your own vault" in ``docs/your-data.md``. */
export const VAULT_RUN_YOUR_OWN_DOC_ANCHOR = 'running-your-own-vault';

/** The plain-language guide for people who run their own vault. */
export const VAULT_RUN_YOUR_OWN_DOC_URL =
  'https://github.com/Geoffe-Ga/adepthood/blob/main/docs/your-data.md#running-your-own-vault';
