/**
 * The personas the Journal chord offers its Aspects under (#2666).
 *
 * The chord names each stage by its free-will persona, which the server owns.
 * It is read from wherever it already is, cheapest first:
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

/** Each stage's persona by stage number; a missing or blank one is unknown. */
export type PersonaByStage = Readonly<Record<number, string | undefined>>;

/** Every stage number the chord offers, ascending. */
const STAGE_NUMBERS: readonly number[] = Array.from({ length: STAGE_COUNT }, (_, i) => i + 1);

/** Whether a persona is worth showing: present and not just whitespace. */
const isKnown = (persona: string | undefined): persona is string =>
  persona !== undefined && persona.trim() !== '';

/** The ten Aspects in ascending order, each under its persona or else its colour name. */
export const buildAspectOptions = (personaByStage: PersonaByStage): AspectOption[] =>
  STAGE_NUMBERS.map((stage) => {
    const persona = personaByStage[stage];
    return { stage, label: isKnown(persona) ? persona : stageFallbackName(stage) };
  });

/** Ask the server for every stage's persona; any failure resolves to none. */
const fetchPersonas = async (): Promise<PersonaByStage> => {
  try {
    const rows = await stages.correspondence();
    return Object.fromEntries(rows.map((row) => [row.stage_number, row.relationship_to_free_will]));
  } catch {
    // Offline, signed out, or a test that mocks the API without a stages
    // client: the chord keeps its colour names, and the page is unaffected.
    return {};
  }
};

/** The chord's options: store personas first, then the visit-free list, then colours. */
export function useAspectOptions(): readonly AspectOption[] {
  const stagesByNumber = useStageStore((state) => state.stagesByNumber);
  const fromStore = useMemo<PersonaByStage>(
    () =>
      Object.fromEntries(
        STAGE_NUMBERS.map((n) => [n, stagesByNumber[n]?.relationshipToFreeWill]).filter(
          ([, persona]) => isKnown(persona as string | undefined),
        ),
      ),
    [stagesByNumber],
  );
  const storeIsComplete = STAGE_NUMBERS.every((n) => isKnown(fromStore[n]));
  const [fetched, setFetched] = useState<PersonaByStage>({});

  useEffect(() => {
    if (storeIsComplete) return undefined;
    let cancelled = false;
    void fetchPersonas().then((personas) => {
      // Nothing learned (offline, or no stages client) leaves the colour names
      // standing without a re-render.
      if (!cancelled && Object.keys(personas).length > 0) setFetched(personas);
    });
    return () => {
      cancelled = true;
    };
  }, [storeIsComplete]);

  return useMemo(() => buildAspectOptions({ ...fetched, ...fromStore }), [fetched, fromStore]);
}
