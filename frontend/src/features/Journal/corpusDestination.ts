/** The Journal surfaces that let someone tend the writing behind their reflections. */
import type { VoiceReadinessT } from '@/api/schemas';

export type CorpusDestination = 'CorpusConsent' | 'SeedCorpus';

/**
 * Keep the invitation band and the permanent drawer door on one routing rule.
 * The decision must come first only while it has not been made; every other
 * readiness state belongs on the import/manage surface.
 */
export function corpusDestinationForReadiness(
  readiness: Pick<VoiceReadinessT, 'state'>,
): CorpusDestination {
  return readiness.state === 'not_consented' ? 'CorpusConsent' : 'SeedCorpus';
}
