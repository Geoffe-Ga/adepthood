/** The Journal surfaces that let someone tend the writing behind their reflections. */
import type { VoiceReadinessT } from '@/api/schemas';
import {
  vaultComesFirst,
  type VaultConnectionState,
} from '@/features/Settings/vaultConnectionState';

export type CorpusDestination = 'CorpusConsent' | 'SeedCorpus' | 'VaultSettings';

/**
 * Keep the invitation band and the permanent drawer door on one routing rule.
 *
 * The decision comes first only while it has not been made. After that, a
 * corpus lives in a vault (#3015): an account the server says has none is shown
 * where its corpus would live rather than a picker whose every document would
 * come back `vault_required`, and every other account -- unknown included --
 * belongs on the import surface.
 */
export function corpusDestinationForReadiness(
  readiness: Pick<VoiceReadinessT, 'state'>,
  vault: VaultConnectionState,
): CorpusDestination {
  if (readiness.state === 'not_consented') return 'CorpusConsent';
  return vaultComesFirst(vault) ? 'VaultSettings' : 'SeedCorpus';
}
