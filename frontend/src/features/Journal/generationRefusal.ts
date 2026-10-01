/**
 * Which 429s are the generation guardrails' own (#623).
 *
 * Both charged journal depths -- a resonance pass and a note's first letter --
 * can be refused before anything is charged: because two of the writer's
 * generations are already in flight, or because today's ceiling of charged
 * generations is reached (decision record §1: "maximum 2 concurrent
 * generations/user"; "configurable launch ceiling of 100 charged
 * generations/day/user"). Neither is a funding refusal -- ``fundingOutcome``
 * stays 402-only -- and the daily one cannot clear before midnight UTC, so a
 * surface uses this to withhold a retry it could not honour.
 */

/** A guardrail refusal: wait for the one in flight, or for midnight UTC. */
export type GenerationRefusal = 'in_progress' | 'daily_limit';

const REFUSALS: Readonly<Record<string, GenerationRefusal>> = Object.freeze({
  generation_in_progress: 'in_progress',
  daily_generation_limit_reached: 'daily_limit',
});

const TOO_MANY_REQUESTS = 429;

/** Classify ``error`` as a guardrail refusal, or ``null`` for any other failure. */
export function generationRefusal(error: unknown): GenerationRefusal | null {
  if (typeof error !== 'object' || error === null) return null;
  const response = error as { status?: unknown; detail?: unknown };
  if (response.status !== TOO_MANY_REQUESTS || typeof response.detail !== 'string') return null;
  return REFUSALS[response.detail] ?? null;
}
