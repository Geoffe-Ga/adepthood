import { useAuthLineage } from '@/hooks/useAuthLineage';

/**
 * The payer lineage a held price, preflight or paid request belongs to.
 *
 * One authenticated session of one account (``useAuthLineage``): a sign-out,
 * another owner, an A to B to A switch, or the same account signing back in
 * after a 401 ends it, and every fence captured under the old one answers
 * ``false`` from then on. A token rotation inside the session does not
 * (#3387, #3409, #3411), so a usage read, a reading or a letter that crossed a
 * proactive refresh, or its own 401-refresh-retry, still settles where it was
 * asked.
 */
export function usePaymentScope(): () => boolean {
  return useAuthLineage().isCurrent;
}
