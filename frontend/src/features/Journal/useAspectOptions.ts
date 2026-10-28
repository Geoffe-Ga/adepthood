/**
 * The names the Journal chord offers its Aspects under (#2666, #3037).
 *
 * The chord names each stage by its Aspect, the capacity's own name ("Agency",
 * "Receptivity", "Community Love"), which the server owns. It never uses the
 * stage's free-will persona: the persona is what a capacity looks like when it
 * runs the show unexamined, so a chip reading "Victim" would have the writer
 * tag their own words with the shadow instead of the note they are naming.
 * The Aspect is read from wherever it already is, cheapest first:
 *
 * 1. the stage store, which the Map and Practice fill from ``GET /stages``;
 * 2. otherwise, once per mount, ``GET /stages/correspondence`` -- global and
 *    visit-free, so opening a page of writing never counts as a program visit
 *    the way reading ``GET /stages`` would;
 * 3. and until (or unless) either answers, the stage's colour name, so the
 *    chooser works offline and before anything has loaded.
 *
 * The journal is the product's floor; nothing here may stand between a writer
 * and the page, so every failure lands on the colour names.
 */
import { useEffect, useMemo, useState } from 'react';

import type { AspectOption } from './AspectChordControl';

import { stages } from '@/api';
import { STAGE_COUNT } from '@/domain/stageProgression';
import { stageFallbackName } from '@/features/Map/stageVocabulary';
import { useStageStore } from '@/store/useStageStore';

/** Each stage's Aspect name by stage number; a missing or blank one is unknown. */
export type AspectByStage = Readonly<Record<number, string | undefined>>;

/** Every stage number the chord offers, ascending. */
const STAGE_NUMBERS: readonly number[] = Array.from({ length: STAGE_COUNT }, (_, i) => i + 1);

/** Whether an Aspect name is worth showing: present and not just whitespace. */
const isKnown = (aspect: string | undefined): aspect is string =>
  aspect !== undefined && aspect.trim() !== '';

/** The ten Aspects in ascending order, each under its Aspect name or else its colour name. */
export const buildAspectOptions = (aspectByStage: AspectByStage): AspectOption[] =>
  STAGE_NUMBERS.map((stage) => {
    const aspect = aspectByStage[stage];
    return { stage, label: isKnown(aspect) ? aspect : stageFallbackName(stage) };
  });

/** Ask the server for every stage's Aspect name; any failure resolves to none. */
const fetchAspects = async (): Promise<AspectByStage> => {
  try {
    const rows = await stages.correspondence();
    return Object.fromEntries(rows.map((row) => [row.stage_number, row.aspect]));
  } catch {
    // Offline, signed out, or a test that mocks the API without a stages
    // client: the chord keeps its colour names, and the page is unaffected.
    return {};
  }
};

/** The chord's options: store Aspect names first, then the visit-free list, then colours. */
export function useAspectOptions(): readonly AspectOption[] {
  const stagesByNumber = useStageStore((state) => state.stagesByNumber);
  const fromStore = useMemo<AspectByStage>(
    () =>
      Object.fromEntries(
        STAGE_NUMBERS.map((n) => [n, stagesByNumber[n]?.aspect]).filter(([, aspect]) =>
          isKnown(aspect as string | undefined),
        ),
      ),
    [stagesByNumber],
  );
  const storeIsComplete = STAGE_NUMBERS.every((n) => isKnown(fromStore[n]));
  const [fetched, setFetched] = useState<AspectByStage>({});

  useEffect(() => {
    if (storeIsComplete) return undefined;
    let cancelled = false;
    void fetchAspects().then((aspects) => {
      // Nothing learned (offline, or no stages client) leaves the colour names
      // standing without a re-render.
      if (!cancelled && Object.keys(aspects).length > 0) setFetched(aspects);
    });
    return () => {
      cancelled = true;
    };
  }, [storeIsComplete]);

  return useMemo(() => buildAspectOptions({ ...fetched, ...fromStore }), [fetched, fromStore]);
}
