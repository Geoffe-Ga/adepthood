/**
 * Stage-display helpers shared by the Course stage selector and the header
 * drawer's table of contents. Colocated here so the pill row and the drawer's
 * stage grouping apply identical color/lock/completion rules without either
 * side redefining them.
 */
import type { Stage } from '../../api';
import { STAGE_ORDER, mixColors, resolveStageColor, surface } from '../../design/tokens';

/** Progress value at which a stage counts as fully completed. */
const COMPLETE_PROGRESS = 1;

/** Fill weight for a locked pill — mixes 40% stage color into the canvas. */
const LOCKED_FILL_WEIGHT = 0.4;

/** Fill weight for a completed, non-active pill — a gentler 80% dim. */
const COMPLETED_FILL_WEIGHT = 0.8;

/**
 * Resolve the background fill for a stage pill, baking any locked/completed
 * dimming into the color itself so the glyph can stay full-opacity. Completed
 * (non-active) wins over locked, matching the prior style precedence; an
 * unlocked, uncompleted pill keeps its raw stage color.
 */
export function stagePillFill(
  color: string,
  state: { unlocked: boolean; completed: boolean; isActive: boolean },
): string {
  let weight: number;
  if (state.completed && !state.isActive) {
    weight = COMPLETED_FILL_WEIGHT;
  } else if (!state.unlocked) {
    weight = LOCKED_FILL_WEIGHT;
  } else {
    return color;
  }
  return mixColors(color, surface.canvas, weight);
}

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

/** Glyph marking a completed stage. */
export const STAGE_COMPLETED_GLYPH = '✓';
/** Glyph marking a locked stage. */
export const STAGE_LOCKED_GLYPH = '🔒';

/** Discriminated marker states for a stage, absent an open (uncompleted, unlocked) stage. */
export const STAGE_STATUS = { Completed: 'completed', Locked: 'locked' } as const;
/** A stage's marker status, or null when the stage is open. */
export type StageStatus = (typeof STAGE_STATUS)[keyof typeof STAGE_STATUS];

/**
 * Resolve a stage's marker status by the shared precedence completed → locked →
 * none, so the pill row and the drawer header classify a stage identically.
 * Returns null for an open stage (unlocked and not yet complete).
 */
export function stageStatus(unlocked: boolean, completed: boolean): StageStatus | null {
  if (completed) return STAGE_STATUS.Completed;
  if (!unlocked) return STAGE_STATUS.Locked;
  return null;
}

/**
 * Thin wrapper mapping the resolved stage status onto its glyph, so glyph
 * consumers share the precedence in stageStatus. Returns null for an open stage.
 */
export function stageStatusGlyph(unlocked: boolean, completed: boolean): string | null {
  const status = stageStatus(unlocked, completed);
  if (status === STAGE_STATUS.Completed) return STAGE_COMPLETED_GLYPH;
  if (status === STAGE_STATUS.Locked) return STAGE_LOCKED_GLYPH;
  return null;
}
