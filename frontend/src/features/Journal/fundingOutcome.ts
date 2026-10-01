/**
 * Which 402s mean "this depth now needs another payer".
 *
 * Both charged journal depths -- a resonance pass and a note's first letter --
 * draw on the same BotMason wallet, and both answer an empty wallet or a missing
 * key with a 402 carrying one of two details. Naming that mapping once keeps the
 * two surfaces routing the same refusal to the same refill remedy instead of
 * one of them rendering it as a generic error.
 */

/** A charged request that now needs the wallet refilled, or a key added. */
export type FundingOutcome = 'funding_required' | 'key_required';

/** Classify ``error`` as a funding refusal, or ``null`` for any other failure. */
export function fundingOutcome(error: unknown): FundingOutcome | null {
  if (typeof error !== 'object' || error === null) return null;
  const response = error as { status?: unknown; detail?: unknown };
  if (response.status !== 402) return null;
  if (response.detail === 'insufficient_offerings') return 'funding_required';
  if (response.detail === 'llm_key_required') return 'key_required';
  return null;
}
