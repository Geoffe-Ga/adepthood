/**
 * Where the privacy policy and the terms of service live, and how the Settings
 * hub addresses them.
 *
 * The documents are hosted by the repository's own web view rather than by this
 * project's API. That is deliberate: a person must be able to read what was
 * promised about their writing on a day the application backend is down, and a
 * store reviewer must be able to open the policy URL before any build exists.
 * The tradeoff is that these URLs are pinned to a path — a rename that leaves
 * this file behind serves a 404 — so a backend test resolves every path here
 * against the repository tree.
 *
 * Swapping in a product domain later is a one-line change per entry; nothing
 * else in the app reads these strings.
 */

/** One legal document, and the Settings row that opens it. */
export interface LegalDocument {
  /** Stable identity, independent of the label a row shows. */
  readonly id: 'privacy' | 'terms';
  /** Row label. */
  readonly label: string;
  /**
   * Row description. Says what the document is for, and never restates a
   * privacy guarantee — the promises belong in the document, where they are
   * pinned to the code, not in a caption that can drift away from them.
   */
  readonly description: string;
  /** Where the row sends the reader. Always ``https``. */
  readonly url: string;
  readonly testID: string;
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    id: 'privacy',
    label: 'Privacy policy',
    description: 'What is collected, where it goes, and what deletion reaches.',
    url: 'https://github.com/Geoffe-Ga/adepthood/blob/main/docs/legal/privacy-policy.md',
    testID: 'settings-row-privacy-policy',
  },
  {
    id: 'terms',
    label: 'Terms of service',
    description: 'The terms this account, and anything you buy, runs under.',
    url: 'https://github.com/Geoffe-Ga/adepthood/blob/main/docs/legal/terms-of-service.md',
    testID: 'settings-row-terms-of-service',
  },
];
