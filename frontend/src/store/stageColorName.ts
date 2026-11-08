/**
 * A stage's Spiral colour name, served first (#2666).
 *
 * The served stage is the source of a stage's colour name: ``GET /stages``
 * returns each ``coursestage`` row's ``spiral_dynamics_color``, and
 * ``stageService`` keeps those rows in ``useStageStore``. ``STAGE_ORDER`` in the
 * design tokens is the one offline fallback, pinned to the artifact the rows are
 * seeded from, and is read only when no served colour is in hand. Every
 * stage-number -> colour-name lookup goes through here, so a correction to the
 * ``coursestage`` row reaches every surface that names a stage by its colour.
 *
 * Three forms, by what the caller holds:
 *
 * - ``stageColorName(n, served)`` -- a served row is already in scope (a
 *   ``StageData``, an API ``Stage``): pass its colour. Pure: it never reads the
 *   store, so the argument is the only served source and cannot be contradicted
 *   by a second one.
 * - ``storedStageColorName(n)`` -- a pure helper with no served row in scope.
 *   Reads the store once, at call time; it does not subscribe, so a component
 *   must not call it to render (its output would freeze at first render).
 * - ``useStageColorName(n)`` / ``useStageColorNames()`` -- a component. They
 *   subscribe, so the name follows the store when the stages arrive.
 */
import { useCallback } from 'react';

import { STAGE_ORDER, canonicalStageColorName } from '@/design/tokens';
import { useStageStore, type StageStoreState } from '@/store/useStageStore';

/** A stage's colour name as the store holds it, or undefined when it holds no such stage. */
const selectServedColor =
  (stageNumber: number) =>
  (state: StageStoreState): string | undefined =>
    state.stagesByNumber[stageNumber]?.spiralDynamicsColor;

/**
 * The colour name of stage ``stageNumber`` (1-based): the ``served`` name when
 * it is non-blank (trimmed, a legacy alias read as its canonical name), else the
 * pinned offline name for that position, else undefined for a stage outside the
 * ten.
 */
export function stageColorName(stageNumber: number, served?: string | null): string | undefined {
  const trimmed = served?.trim() ?? '';
  if (trimmed !== '') return canonicalStageColorName(trimmed);
  return STAGE_ORDER[stageNumber - 1];
}

/** The colour name of a stage as the stage store holds it now; see the module note. */
export function storedStageColorName(stageNumber: number): string | undefined {
  return stageColorName(stageNumber, selectServedColor(stageNumber)(useStageStore.getState()));
}

/** The colour name of a stage, re-rendering when the store's row for it changes; none for no stage. */
export function useStageColorName(stageNumber: number | null): string | undefined {
  const served = useStageStore((state) =>
    stageNumber === null ? undefined : selectServedColor(stageNumber)(state),
  );
  return stageNumber === null ? undefined : stageColorName(stageNumber, served);
}

/**
 * A colour-name lookup for a component that names many stages at once (a chip
 * strip of all ten), re-rendering when the stage store's rows change.
 */
export function useStageColorNames(): (stageNumber: number) => string | undefined {
  const stagesByNumber = useStageStore((state) => state.stagesByNumber);
  return useCallback(
    (stageNumber: number) =>
      stageColorName(stageNumber, stagesByNumber[stageNumber]?.spiralDynamicsColor),
    [stagesByNumber],
  );
}
