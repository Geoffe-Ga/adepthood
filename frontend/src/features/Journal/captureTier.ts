/**
 * The tier a photograph capture declares in append mode (#3059 AC15).
 *
 * A capture opened from an entry already being written reads pages INTO that
 * entry, so the entry's own tier, carried in the route's ``appendTier``, is a
 * floor: the writer may narrow the capture toward ``intimate`` (which reads
 * nothing) but never widen it. A value that is not a known tier -- absent,
 * empty, misspelled, a different case -- fails closed to ``intimate``, which the
 * capture's own gate (#1882) and the server's ``tier_refused`` both decline to
 * read.
 */
import type { PrivacyTier } from './PrivacyTierControl';

/** Every tier the client knows, by openness: a higher rank is more private. */
const TIER_RANK: Readonly<Record<PrivacyTier, number>> = {
  public: 0,
  personal: 1,
  intimate: 2,
};

/** The tier an unknown or missing append-mode tier is treated as. */
const FAIL_CLOSED_TIER: PrivacyTier = 'intimate';

/**
 * The floor an append-mode capture may not go below, or ``null`` outside append
 * mode (where the writer chooses freely before Transcribe).
 */
export function appendModeTier(
  appendTo: string | undefined,
  appendTier: string | undefined,
): PrivacyTier | null {
  if (appendTo == null) return null;
  if (appendTier == null || !Object.hasOwn(TIER_RANK, appendTier)) return FAIL_CLOSED_TIER;
  return appendTier as PrivacyTier;
}

/** Whether ``tier`` is at least as private as ``floor`` (anything, with no floor). */
export function withinFloor(floor: PrivacyTier | null, tier: PrivacyTier): boolean {
  return floor == null || TIER_RANK[tier] >= TIER_RANK[floor];
}
