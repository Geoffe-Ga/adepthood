/**
 * Single source of truth for BYOK providers (issue #403).
 *
 * Adding a provider is a one-entry edit here — label, key prefix, the
 * console page where keys are created, and the user-facing hint. The
 * prefix rules mirror the backend's `_PROVIDER_KEY_RULES` in
 * `backend/src/services/botmason.py` (Anthropic keys carry the more
 * specific `sk-ant-` prefix, so OpenAI disallows it to prevent
 * cross-wiring); keep the two maps in sync when extending.
 */

export interface ByokProvider {
  id: 'openai' | 'anthropic';
  label: string;
  keyPrefix: string;
  /** More-specific prefixes that must NOT match (prevents cross-wiring). */
  disallowedPrefixes: readonly string[];
  /** The provider console page where the user creates a key. */
  keyPageUrl: string;
  /** Short guidance shown beside the provider entry. */
  hint: string;
}

export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyPrefix: 'sk-',
    disallowedPrefixes: ['sk-ant-'],
    keyPageUrl: 'https://platform.openai.com/api-keys',
    hint: 'Paste your OpenAI key — starts with "sk-".',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyPrefix: 'sk-ant-',
    disallowedPrefixes: [],
    keyPageUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Paste your Anthropic key — starts with "sk-ant-".',
  },
];

/**
 * Detect which provider a pasted key belongs to, or `null` for garbage.
 *
 * The disallowed-prefix rule makes matching order-independent: an
 * `sk-ant-` key fails the OpenAI rule and matches only Anthropic.
 */
export function providerForKey(key: string): ByokProvider | null {
  for (const provider of BYOK_PROVIDERS) {
    if (
      key.startsWith(provider.keyPrefix) &&
      !provider.disallowedPrefixes.some((bad) => key.startsWith(bad))
    ) {
      return provider;
    }
  }
  return null;
}
