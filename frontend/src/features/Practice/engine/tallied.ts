// Pure decomposition helpers for the `tallied_grounding` mode. The engine
// keeps a single linear `currentStepIndex`; both the reducer (completion
// detection, progress) and `TalliedGroundingView` (header copy) derive the
// `(round, category, item)` position from it through this module so the
// arithmetic lives in exactly one place.

import type { TalliedCategory, TalliedGroundingConfig } from './types';

/** Steps in a single round: the sum of every category's target count. */
export function totalStepsPerRound(config: TalliedGroundingConfig): number {
  return config.categories.reduce((sum, category) => sum + category.target_count, 0);
}

/** Total taps to finish the ritual: `rounds × totalStepsPerRound`. */
export function totalSteps(config: TalliedGroundingConfig): number {
  return config.rounds * totalStepsPerRound(config);
}

/**
 * Position of a linear step within the ritual. All indices are 0-based;
 * the view adds 1 for display.
 */
export interface TalliedPosition {
  roundIndex: number;
  category: TalliedCategory;
  categoryIndex: number;
  itemInCategory: number;
}

/**
 * Map a linear `stepIndex` to its `(round, category, item)` position.
 *
 * `stepIndex` is clamped into `[0, totalSteps)` so the final
 * complete-state index (`stepIndex === totalSteps`) resolves to the last
 * item rather than overflowing. Throws when `config.categories` is empty
 * — the backend's `min_length=1` constraint makes that an invalid config,
 * not a state the engine can reach.
 */
export function decompose(stepIndex: number, config: TalliedGroundingConfig): TalliedPosition {
  const perRound = totalStepsPerRound(config);
  const clamped = Math.max(0, Math.min(stepIndex, totalSteps(config) - 1));
  const roundIndex = Math.floor(clamped / perRound);
  let cursor = clamped % perRound;
  let categoryIndex = 0;
  for (const category of config.categories) {
    if (cursor < category.target_count) {
      return { roundIndex, category, categoryIndex, itemInCategory: cursor };
    }
    cursor -= category.target_count;
    categoryIndex += 1;
  }
  throw new Error('decompose: tallied-grounding config has no categories');
}
