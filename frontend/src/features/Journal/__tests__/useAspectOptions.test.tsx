/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { buildAspectOptions, useAspectOptions } from '../useAspectOptions';

import type { StageCorrespondence } from '@/api';
import { STAGE_ORDER } from '@/design/tokens';
import {
  CANON_STAGE_OVERRIDES,
  createCanonicalStages,
  GOLDEN_STAGE_NUMBERS,
  mockMakeCanonicalStage,
} from '@/features/Map/__tests__/stageVocabularyGolden';
import { useStageStore } from '@/store/useStageStore';

/**
 * The Journal chord's Aspect names come from the server without the Journal
 * ever counting as a program visit (#2666), and they are the Aspect's own name,
 * never the stage's free-will persona (#3037). The stage store wins when the Map or
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

/** The Aspect name a freshly seeded database serves for ``stage``. */
const canonAspect = (stage: number): string => {
  const canon = CANON_STAGE_OVERRIDES[stage];
  if (canon === undefined) throw new Error(`no canon for stage ${stage}`);
  return canon.aspect;
};

/** A served correspondence row for ``stage`` under Aspect name ``aspect``. */
const row = (stage: number, aspect: string): StageCorrespondence => ({
  stage_key: `stage-${stage}`,
  stage_number: stage,
  start_week: stage,
  category: 'Category',
  aspect,
  spiral_dynamics_color: STAGE_ORDER[stage - 1] ?? '',
  growing_up_stage: 'Growing',
  divine_gender_polarity: 'Divine Feminine',
  relationship_to_free_will: 'A Persona The Chord Must Not Show',
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

/** Every stage served under its canon Aspect name, with ``overrides`` by stage. */
const servedRows = (overrides: Record<number, string> = {}): StageCorrespondence[] =>
  GOLDEN_STAGE_NUMBERS.map((n) => row(n, overrides[n] ?? canonAspect(n)));

const canonLabels = (): string[] => GOLDEN_STAGE_NUMBERS.map((n) => canonAspect(n));

beforeEach(() => {
  mockCorrespondence.mockReset();
  mockListAll.mockReset();
  useStageStore.getState().setStages([]);
});

describe('buildAspectOptions', () => {
  it('offers the ten stages in ascending order under their Aspect names', () => {
    const aspects = Object.fromEntries(GOLDEN_STAGE_NUMBERS.map((n) => [n, canonAspect(n)]));
    expect(buildAspectOptions(aspects)).toEqual(
      GOLDEN_STAGE_NUMBERS.map((stage) => ({ stage, label: canonAspect(stage) })),
    );
  });

  it('names a missing or blank Aspect by the stage colour', () => {
    const options = buildAspectOptions({ 2: 'Receptivity', 3: '   ' });
    expect(options).toHaveLength(STAGE_ORDER.length);
    expect(options[0]).toEqual({ stage: 1, label: 'Beige' });
    expect(options[1]).toEqual({ stage: 2, label: 'Receptivity' });
    expect(options[2]).toEqual({ stage: 3, label: 'Red' });
  });
});

describe('useAspectOptions', () => {
  it('never labels a stage by its free-will persona, even when the server serves one', async () => {
    // The persona ("Victim", "Dominator") is a capacity running unexamined; the
    // chord names the note, never the shadow (chords, not rungs).
    useStageStore
      .getState()
      .setStages(
        createCanonicalStages().map((stage) =>
          stage.stageNumber === 4
            ? { ...stage, aspect: 'Community Love', relationshipToFreeWill: 'Victim' }
            : stage,
        ),
      );
    const { result } = renderHook(() => useAspectOptions());
    await waitFor(() => expect(result.current[3]?.label).toBe('Community Love'));
    expect(result.current.map((o) => o.label)).not.toContain('Victim');
    expect(mockCorrespondence).not.toHaveBeenCalled();
  });

  it('reads a full store and fetches nothing', async () => {
    useStageStore.getState().setStages(createCanonicalStages());
    const { result } = renderHook(() => useAspectOptions());
    expect(result.current.map((o) => o.label)).toEqual(canonLabels());
    await waitFor(() => {
      expect(mockCorrespondence).not.toHaveBeenCalled();
    });
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('reads the server Aspect name from the correspondence list when the store is empty', async () => {
    mockCorrespondence.mockResolvedValue(servedRows({ 2: 'Rewritten Purple Aspect' }));
    const { result } = renderHook(() => useAspectOptions());
    // Colour names stand until the server answers, so nothing is ever blank.
    expect(result.current[1]).toEqual({ stage: 2, label: 'Purple' });
    await waitFor(() => {
      expect(result.current[1]).toEqual({ stage: 2, label: 'Rewritten Purple Aspect' });
    });
    expect(mockCorrespondence).toHaveBeenCalledTimes(1);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('keeps the store Aspect name over the fetched one for a stage the store holds', async () => {
    useStageStore.getState().setStages([mockMakeCanonicalStage(2, { aspect: 'Store Aspect' })]);
    mockCorrespondence.mockResolvedValue(servedRows({ 2: 'Fetched Aspect' }));
    const { result } = renderHook(() => useAspectOptions());
    await waitFor(() => {
      expect(result.current[0]).toEqual({ stage: 1, label: canonAspect(1) });
    });
    expect(result.current[1]).toEqual({ stage: 2, label: 'Store Aspect' });
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
