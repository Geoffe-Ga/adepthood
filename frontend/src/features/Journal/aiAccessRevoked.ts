/**
 * Whether a refused AI request was refused for a revoked entitlement (#1938, B21 E1).
 *
 * A member whose APTITUDE entitlement was refunded, disputed or revoked by the
 * operator is refused a keyless reading, letter or page read with
 * ``403 ai_access_revoked``. Unlike a busy slot or a blip, asking again cannot
 * succeed, and unlike a 402 no refill would help -- so a surface uses this to
 * withhold its retry, beside ``generationRefusal`` and ``fundingOutcome``.
 */

const FORBIDDEN = 403;
const AI_ACCESS_REVOKED = 'ai_access_revoked';

/** True only for the server's 403 ``ai_access_revoked`` refusal. */
export function aiAccessRevoked(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const response = error as { status?: unknown; detail?: unknown };
  return response.status === FORBIDDEN && response.detail === AI_ACCESS_REVOKED;
}
