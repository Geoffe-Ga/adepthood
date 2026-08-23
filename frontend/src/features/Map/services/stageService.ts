/**
 * Stage service — orchestrates API calls for stages and writes the result into
 * `useStageStore`. This keeps API access out of the Zustand store, which is a
 * pure state container.
 *
 * Consumers should call `stageService.loadStages()` from hooks / effects and
 * read state via `useStageStore` selectors.
 */

import { stages as stagesApi } from '../../../api';
import type { Stage } from '../../../api';
import { STAGE_COLORS, STAGE_ORDER } from '../../../design/tokens';
import { FULLY_COMPLETE } from '../../../domain/stageProgression';
import { useStageStore } from '../../../store/useStageStore';
import { STAGE_COUNT } from '../stageData';
import type { StageData } from '../stageData';

/**
 * Clamp a backend-supplied progress fraction into ``[0, 1]`` (BUG-FE-MAP-003).
 * NaN / Infinity / missing values resolve to 0; values above 1 are
 * pinned to 1 so the progress bar never overflows its container.
 */
export const clampProgress = (raw: number | null | undefined): number => {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
};

/** Convert a backend Stage response into a frontend StageData with layout. */
export const toStageData = (apiStage: Stage): StageData => {
  const colorName = STAGE_ORDER[apiStage.stage_number - 1] ?? 'Beige';
  return {
    id: apiStage.id,
    title: apiStage.title,
    subtitle: apiStage.subtitle,
    stageNumber: apiStage.stage_number,
    // BUG-FE-MAP-003: clamp progress into ``[0, 1]`` and coerce NaN /
    // missing values to 0.  Without this guard a bad payload renders
    // as "NaN%" or overflows the progress bar (width: 110%).
    progress: clampProgress(apiStage.progress),
    color: STAGE_COLORS[colorName] ?? '#888',
    isUnlocked: apiStage.is_unlocked,
    category: apiStage.category,
    aspect: apiStage.aspect,
    spiralDynamicsColor: apiStage.spiral_dynamics_color,
    growingUpStage: apiStage.growing_up_stage,
    divineGenderPolarity: apiStage.divine_gender_polarity,
    relationshipToFreeWill: apiStage.relationship_to_free_will,
    freeWillDescription: apiStage.free_will_description,
    overviewUrl: apiStage.overview_url,
    manifestations: apiStage.manifestations ?? [],
  };
};

/** Unlocked on the map when the server `is_unlocked` flag is set OR the server's current stage has reached it, so the padlock matches the Practice/Course stage. */
export const isStageUnlocked = (
  stage: Pick<StageData, 'isUnlocked' | 'stageNumber'>,
  currentStage: number | null,
): boolean => stage.isUnlocked || (currentStage !== null && stage.stageNumber <= currentStage);

/** Highest stage number whose progress has reached 100%, or 0 when none is complete — the baseline the completion celebration watches for a rise. */
export const highestCompletedStage = (
  stages: readonly Pick<StageData, 'progress' | 'stageNumber'>[],
): number =>
  stages.reduce((max, s) => (s.progress >= FULLY_COMPLETE ? Math.max(max, s.stageNumber) : max), 0);

/** True only on the final stage with its progress complete — the gate for the declinable "begin again" affordance. */
export const isEndOfCycle = (
  stagesByNumber: Record<number, { progress: number } | undefined>,
  currentStage: number,
): boolean =>
  currentStage === STAGE_COUNT && (stagesByNumber[STAGE_COUNT]?.progress ?? 0) >= FULLY_COMPLETE;

/**
 * Seed the current stage and the cycle indicator from the program calendar.
 *
 * ``current_stage`` is the server's one answer to which stage this person is
 * in: the union of the stage its calendar has opened and the stage its record
 * says they have entered, already reconciled server-side before the response
 * is written. The client takes it rather than recomputing anything from the
 * stage list, because a completion count is a different quantity from both --
 * someone who has been away for two months has several stages open and nothing
 * newly complete, and counting completions would report the stage they last
 * finished.
 *
 * A failure here must never break the stage list, so it is swallowed and the
 * values already in the store stand.
 */
const seedFromProgramCalendar = async (token?: string): Promise<void> => {
  try {
    const calendar = await stagesApi.programCalendar(token);
    const store = useStageStore.getState();
    store.setCurrentStage(calendar.current_stage);
    store.setCycleNumber(calendar.cycle_number);
  } catch {
    // Non-fatal: cold-start seeding is best-effort; keep the current values.
  }
};

export const stageService = {
  /**
   * Fetch the stage list, map to StageData, and write it into the store. On
   * failure, leaves existing state in place and records an error message.
   */
  loadStages: async (token?: string): Promise<void> => {
    const store = useStageStore.getState();
    store.setLoading(true);
    store.setError(null);
    // Marked at request start, not on settle, so the attempt lands in the same
    // synchronous window as ``setLoading`` — an unmount mid-flight still counts.
    store.markAttempted();
    try {
      const apiStages = await stagesApi.listAll(token);
      // Sort descending by stage_number (10 at top, 1 at bottom) to match
      // the background artwork.
      const sorted = [...apiStages].sort((a, b) => b.stage_number - a.stage_number);
      useStageStore.getState().setStages(sorted.map(toStageData));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stages';
      useStageStore.getState().setError(message);
      useStageStore.getState().setLoading(false);
      return;
    }
    // Awaited before the load settles so the first painted grid already carries
    // the server's stage, rather than flashing a stale one.
    await seedFromProgramCalendar(token);
    useStageStore.getState().setLoading(false);
  },

  /**
   * Open a fresh cycle: record the server's new cycle number, then reload
   * stages so state resets from server truth. Mirrors `loadStages`'s
   * error handling — a failed begin-again POST routes to `useStageStore.error`
   * rather than rejecting unhandled, since the call site discards the promise.
   */
  beginAgain: async (token?: string): Promise<void> => {
    try {
      const record = await stagesApi.beginAgain(token);
      useStageStore.getState().setCycleNumber(record.cycle_number);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to begin again';
      useStageStore.getState().setError(message);
      return;
    }
    await stageService.loadStages(token);
  },
};
