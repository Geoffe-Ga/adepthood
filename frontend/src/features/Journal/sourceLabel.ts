/**
 * ``sourceLabel`` — the words beside a margin note, a letter or a pass that say
 * which side answered it (#3062).
 *
 * The input is whatever the server recorded, read as ``unknown`` on purpose: a
 * note listing is not schema-validated on the way in, an older server sends no
 * field at all, and a newer one may send a value this build has never heard
 * of. Every one of those reads "Source not recorded". The switch is total over
 * exact strings and its default is that same label, so no input can be widened
 * into a vault, a local model or a real reflection.
 *
 * Nothing here reads the vault connection. Whether a vault is connected *now*
 * says nothing about which side answered a note written earlier, and the two
 * must never be derived from each other.
 */

/**
 * DRAFT copy, pending owner review (#3062 escalation E3; B01 owns the public
 * vocabulary). Deliberately neutral: no vendor names, and no "local",
 * "private" or "in your vault" claim, which the vault's reflect response cannot
 * support today (it reports no model identity).
 */
export const SOURCE_LABEL_COPY = {
  demo: 'Demo — not a real reflection',
  creekVault: 'From your Creek vault',
  appProvider: "From the app's AI provider",
  notRun: 'No check was run',
  notRecorded: 'Source not recorded',
} as const;

export function sourceLabel(source: unknown): string {
  switch (source) {
    case 'demo':
      return SOURCE_LABEL_COPY.demo;
    case 'creek_vault':
      return SOURCE_LABEL_COPY.creekVault;
    case 'app_provider':
      return SOURCE_LABEL_COPY.appProvider;
    case 'none':
      return SOURCE_LABEL_COPY.notRun;
    default:
      return SOURCE_LABEL_COPY.notRecorded;
  }
}

/** Whether ``source`` is the stub provider's demo, read with the same exactness. */
export function isDemoSource(source: unknown): boolean {
  return source === 'demo';
}
