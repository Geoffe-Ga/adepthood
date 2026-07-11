/**
 * Stage-display helpers shared by the Course stage selector and the header
 * drawer's table of contents. Colocated here so the pill row and the drawer's
 * stage grouping apply identical color/lock/completion rules without either
 * side redefining them.
 */
import type { Stage } from '../../api';
import { STAGE_ORDER, resolveStageColor } from '../../design/tokens';

/** Progress value at which a stage counts as fully completed. */
const COMPLETE_PROGRESS = 1;

/** Derive the total number of stages from the API response (the max number). */
export function totalStageCount(stages: Stage[]): number {
  if (stages.length === 0) return 0;
  return Math.max(...stages.map((s) => s.stage_number));
}

/** Resolve the Spiral-Dynamics color for a stage number (1-indexed). */
export function getStageColor(stageNumber: number, stageById: Map<number, Stage>): string {
  // Prefer the stage's own API color; fall back to its progression-order name
  // when the API omits that stage number. The shared resolver handles the
  // neutral fallback for missing or unrecognized names.
  const name = stageById.get(stageNumber)?.spiral_dynamics_color ?? STAGE_ORDER[stageNumber - 1];
  return resolveStageColor(name);
}

/** Determine whether a stage is unlocked based on API data. */
export function isUnlocked(stageNumber: number, stageById: Map<number, Stage>): boolean {
  return stageById.get(stageNumber)?.is_unlocked ?? false;
}

/** Determine whether a stage has been completed (progress reached 1.0). */
export function isCompleted(stageNumber: number, stageById: Map<number, Stage>): boolean {
  const stage = stageById.get(stageNumber);
  return stage != null && stage.progress >= COMPLETE_PROGRESS;
}
