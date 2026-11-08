import { storedStageColorName } from '@/store/stageColorName';

/**
 * Resolve a 1-based stage number to its Spiral-Dynamics color name (e.g. stage
 * 2 -> "Purple") -- the one the stage store was served, else the offline name
 * (#2666) -- falling back to ``Stage {n}`` when the number falls outside the
 * ten named stages.
 */
export function stageDisplayName(n: number): string {
  return storedStageColorName(n) ?? `Stage ${n}`;
}

/** Combine the stage's name with its number, e.g. ``Purple (stage 2)``. */
export function stageLabel(n: number): string {
  return `${stageDisplayName(n)} (stage ${n})`;
}
