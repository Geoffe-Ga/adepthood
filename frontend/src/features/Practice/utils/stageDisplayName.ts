import { STAGE_ORDER } from '@/design/tokens';

/**
 * Resolve a 1-based stage number to its Spiral-Dynamics color name (e.g. stage
 * 2 -> "Purple"), falling back to ``Stage {n}`` when the number falls outside
 * the ten named stages. The index guard also satisfies
 * ``noUncheckedIndexedAccess`` (out-of-range reads are ``undefined``).
 */
export function stageDisplayName(n: number): string {
  const name = STAGE_ORDER[n - 1];
  return name ?? `Stage ${n}`;
}

/** Combine the stage's name with its number, e.g. ``Purple (stage 2)``. */
export function stageLabel(n: number): string {
  return `${stageDisplayName(n)} (stage ${n})`;
}
