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

type InferenceProvider = 'openai' | 'anthropic' | 'creek' | 'stub';

/** A recorded provider's display name. Shared with the pass receipt's fuller lines. */
export const INFERENCE_PROVIDER_NAMES: Record<InferenceProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  creek: 'Creek',
  stub: 'Demo',
};

/** The provider each source already names, so repeating it says nothing new. */
const PROVIDER_IMPLIED_BY_SOURCE: Partial<Record<string, InferenceProvider>> = {
  creek_vault: 'creek',
  demo: 'stub',
};

/**
 * The one quiet line a margin note adds beneath its source label: the reported
 * provider and model, or ``null`` when there is nothing the label has not said.
 *
 * A card repeats on every note, so it carries only what adds information. A
 * provider the source already implies ("From your Creek vault" / Creek) is
 * dropped, and an identity that was not recorded is left unsaid rather than
 * announced -- the pass receipt still spells out every absence. "Reported"
 * keeps the hedge: the identity is the server's disclosure, not attestation.
 */
export function reportedIdentityCaption(
  source: unknown,
  provider: InferenceProvider | null | undefined,
  model: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (provider != null && PROVIDER_IMPLIED_BY_SOURCE[String(source)] !== provider) {
    parts.push(INFERENCE_PROVIDER_NAMES[provider]);
  }
  if (model) parts.push(model);
  return parts.length > 0 ? `Reported: ${parts.join(' · ')}` : null;
}
