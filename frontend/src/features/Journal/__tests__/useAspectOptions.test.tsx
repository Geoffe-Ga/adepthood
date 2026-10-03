/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { buildAspectOptions, useAspectOptions } from '../useAspectOptions';

import type { StageCorrespondence } from '@/api';
import { STAGE_ORDER } from '@/design/tokens';
import {
  createCanonicalStages,
  GOLDEN_STAGE_NUMBERS,
  goldenStage,
  mockMakeCanonicalStage,
} from '@/features/Map/__tests__/stageVocabularyGolden';
import { useStageStore } from '@/store/useStageStore';

/**
 * The Journal chord's personas come from the server without the Journal ever
 * counting as a program visit (#2666). The stage store wins when the Map or
 * Practice has already filled it; otherwise the hook reads the visit-free
 * ``GET /stages/correspondence`` once; and offline, or under a mocked API with
 * no ``stages`` client at all, every chip still reads its colour name.
 */

const mockCorrespondence = jest.fn<() => Promise<StageCorrespondence[]>>();
const mockListAll = jest.fn();

jest.mock('@/api', () => ({
  stages: {
    correspondence: () => mockCorrespondence(),
    listAll: (...args: unknown[]) => mockListAll(...args),
  },
}));

/** A served correspondence row for ``stage``, persona ``persona``. */
const row = (stage: number, persona: string): StageCorrespondence => ({
  stage_key: `stage-${stage}`,
  stage_number: stage,
  start_week: stage,
  category: 'Category',
  aspect: 'Aspect',
  spiral_dynamics_color: STAGE_ORDER[stage - 1] ?? '',
  growing_up_stage: 'Growing',
  divine_gender_polarity: 'Divine Feminine',
  relationship_to_free_will: persona,
  free_will_description: 'Description.',
  provenance: {
    source_repo: null,
    source_sha: null,
    source_path: null,
    source_sha256: null,
    schema_version: null,
    reconciled_at: null,
  },
});

/** Every stage served under its golden persona, with ``overrides`` by stage. */
const servedRows = (overrides: Record<number, string> = {}): StageCorrespondence[] =>
  GOLDEN_STAGE_NUMBERS.map((n) => row(n, overrides[n] ?? goldenStage(n).persona));

const goldenLabels = (): string[] => GOLDEN_STAGE_NUMBERS.map((n) => goldenStage(n).persona);

beforeEach(() => {
  mockCorrespondence.mockReset();
  mockListAll.mockReset();
  useStageStore.getState().setStages([]);
});

describe('buildAspectOptions', () => {
  it('offers the ten stages in ascending order under their personas', () => {
    const personas = Object.fromEntries(
      GOLDEN_STAGE_NUMBERS.map((n) => [n, goldenStage(n).persona]),
    );
    expect(buildAspectOptions(personas)).toEqual(
      GOLDEN_STAGE_NUMBERS.map((stage) => ({ stage, label: goldenStage(stage).persona })),
    );
  });

  it('names a missing or blank persona by the stage colour', () => {
    const options = buildAspectOptions({ 2: 'Pleasure Seeker', 3: '   ' });
    expect(options).toHaveLength(STAGE_ORDER.length);
    expect(options[0]).toEqual({ stage: 1, label: 'Beige' });
    expect(options[1]).toEqual({ stage: 2, label: 'Pleasure Seeker' });
    expect(options[2]).toEqual({ stage: 3, label: 'Red' });
  });
});

describe('useAspectOptions', () => {
  it('reads a full store and fetches nothing', async () => {
    useStageStore.getState().setStages(createCanonicalStages());
    const { result } = renderHook(() => useAspectOptions());
    expect(result.current.map((o) => o.label)).toEqual(goldenLabels());
    await waitFor(() => {
      expect(mockCorrespondence).not.toHaveBeenCalled();
    });
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('reads the server persona from the correspondence list when the store is empty', async () => {
    mockCorrespondence.mockResolvedValue(servedRows({ 2: 'Rewritten Purple Persona' }));
    const { result } = renderHook(() => useAspectOptions());
    // Colour names stand until the server answers, so nothing is ever blank.
    expect(result.current[1]).toEqual({ stage: 2, label: 'Purple' });
    await waitFor(() => {
      expect(result.current[1]).toEqual({ stage: 2, label: 'Rewritten Purple Persona' });
    });
    expect(mockCorrespondence).toHaveBeenCalledTimes(1);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('keeps the store persona over the fetched one for a stage the store holds', async () => {
    useStageStore
      .getState()
      .setStages([mockMakeCanonicalStage(2, { relationshipToFreeWill: 'Store Persona' })]);
    mockCorrespondence.mockResolvedValue(servedRows({ 2: 'Fetched Persona' }));
    const { result } = renderHook(() => useAspectOptions());
    await waitFor(() => {
      expect(result.current[0]).toEqual({ stage: 1, label: goldenStage(1).persona });
    });
    expect(result.current[1]).toEqual({ stage: 2, label: 'Store Persona' });
    expect(mockCorrespondence).toHaveBeenCalledTimes(1);
  });

  it('falls back to colour names when the server cannot be reached', async () => {
    mockCorrespondence.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAspectOptions());
    await waitFor(() => {
      expect(mockCorrespondence).toHaveBeenCalledTimes(1);
    });
    expect(result.current.map((o) => o.label)).toEqual([...STAGE_ORDER]);
  });

  it('falls back to colour names when the client throws before it can ask', async () => {
    mockCorrespondence.mockImplementation(() => {
      throw new TypeError('stages is undefined');
    });
    const { result } = renderHook(() => useAspectOptions());
    await waitFor(() => {
      expect(mockCorrespondence).toHaveBeenCalledTimes(1);
    });
    expect(result.current.map((o) => o.label)).toEqual([...STAGE_ORDER]);
  });

  it('ignores an answer that arrives after the screen has gone', async () => {
    let resolve: (_rows: StageCorrespondence[]) => void = () => undefined;
    mockCorrespondence.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, unmount } = renderHook(() => useAspectOptions());
    const before = result.current;
    unmount();
    resolve(servedRows({ 2: 'Too Late' }));
    await Promise.resolve();
    expect(result.current).toBe(before);
  });
});
