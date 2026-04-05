import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Stage } from '../../api';
import type { StageData } from '../../features/Map/stageData';

// Mock the API module
const mockList = jest.fn() as jest.MockedFunction<() => Promise<Stage[]>>;
jest.mock('../../api', () => ({
  stages: { list: () => mockList() },
}));

/** Build a fake API Stage response. */
function makeApiStage(stageNumber: number, overrides: Partial<Stage> = {}): Stage {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stage_number: stageNumber,
    overview_url: '',
    category: 'Test',
    aspect: 'Aspect',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: 'Growing',
    divine_gender_polarity: 'Polarity',
    relationship_to_free_will: 'Free Will',
    free_will_description: 'Desc',
    is_unlocked: stageNumber <= 2,
    progress: stageNumber === 1 ? 0.5 : 0,
    ...overrides,
  };
}

describe('useStageStore', () => {
  beforeEach(() => {
    jest.resetModules();
    mockList.mockReset();
  });

  it('starts with empty stages and loading false', () => {
    const { useStageStore } = require('../useStageStore');
    const state = useStageStore.getState();
    expect(state.stages).toHaveLength(0);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('setStages replaces the stages array', () => {
    const { useStageStore } = require('../useStageStore');
    const newStages: StageData[] = [
      {
        id: 1,
        title: 'Custom Stage',
        subtitle: 'Test',
        stageNumber: 1,
        progress: 0.75,
        color: '#fff',
        isUnlocked: true,
        category: '',
        aspect: '',
        spiralDynamicsColor: '',
        growingUpStage: '',
        divineGenderPolarity: '',
        relationshipToFreeWill: '',
        freeWillDescription: '',
        overviewUrl: '',
        hotspots: [],
      },
    ];

    act(() => useStageStore.getState().setStages(newStages));
    expect(useStageStore.getState().stages).toEqual(newStages);
  });

  it('setCurrentStage updates the current stage number', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => useStageStore.getState().setCurrentStage(5));
    expect(useStageStore.getState().currentStage).toBe(5);
  });

  it('updateStageProgress updates a specific stage progress', () => {
    const { useStageStore } = require('../useStageStore');
    // Seed with one stage
    act(() =>
      useStageStore.getState().setStages([
        {
          id: 1,
          title: 'S1',
          subtitle: '',
          stageNumber: 1,
          progress: 0,
          color: '#fff',
          isUnlocked: true,
          category: '',
          aspect: '',
          spiralDynamicsColor: '',
          growingUpStage: '',
          divineGenderPolarity: '',
          relationshipToFreeWill: '',
          freeWillDescription: '',
          overviewUrl: '',
          hotspots: [],
        },
      ]),
    );

    act(() => useStageStore.getState().updateStageProgress(1, 0.8));
    const stage1 = useStageStore.getState().stages.find((s: StageData) => s.stageNumber === 1);
    expect(stage1!.progress).toBe(0.8);
  });

  it('updateStageProgress does nothing for unknown stage', () => {
    const { useStageStore } = require('../useStageStore');
    act(() =>
      useStageStore.getState().setStages([
        {
          id: 1,
          title: 'S1',
          subtitle: '',
          stageNumber: 1,
          progress: 0.5,
          color: '#fff',
          isUnlocked: true,
          category: '',
          aspect: '',
          spiralDynamicsColor: '',
          growingUpStage: '',
          divineGenderPolarity: '',
          relationshipToFreeWill: '',
          freeWillDescription: '',
          overviewUrl: '',
          hotspots: [],
        },
      ]),
    );
    const before = useStageStore.getState().stages.map((s: StageData) => s.progress);
    act(() => useStageStore.getState().updateStageProgress(99, 1.0));
    const after = useStageStore.getState().stages.map((s: StageData) => s.progress);
    expect(after).toEqual(before);
  });

  it('fetchStages loads from API, sorts descending, and maps to StageData', async () => {
    const apiStages = [makeApiStage(1), makeApiStage(2), makeApiStage(3)];
    mockList.mockResolvedValueOnce(apiStages);

    const { useStageStore } = require('../useStageStore');
    await act(async () => {
      await useStageStore.getState().fetchStages();
    });

    const state = useStageStore.getState();
    expect(state.stages).toHaveLength(3);
    // Should be sorted descending by stageNumber
    expect(state.stages[0].stageNumber).toBe(3);
    expect(state.stages[1].stageNumber).toBe(2);
    expect(state.stages[2].stageNumber).toBe(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('fetchStages sets currentStage to first unlocked incomplete stage', async () => {
    const apiStages = [
      makeApiStage(1, { is_unlocked: true, progress: 1 }), // completed
      makeApiStage(2, { is_unlocked: true, progress: 0.3 }), // in progress
      makeApiStage(3, { is_unlocked: false, progress: 0 }),
    ];
    mockList.mockResolvedValueOnce(apiStages);

    const { useStageStore } = require('../useStageStore');
    await act(async () => {
      await useStageStore.getState().fetchStages();
    });

    expect(useStageStore.getState().currentStage).toBe(2);
  });

  it('fetchStages sets error on API failure', async () => {
    mockList.mockRejectedValueOnce(new Error('Network error'));

    const { useStageStore } = require('../useStageStore');
    await act(async () => {
      await useStageStore.getState().fetchStages();
    });

    const state = useStageStore.getState();
    expect(state.error).toBe('Network error');
    expect(state.loading).toBe(false);
    expect(state.stages).toHaveLength(0);
  });

  it('fetchStages maps metadata fields correctly', async () => {
    const apiStages = [
      makeApiStage(1, {
        category: 'Survival',
        aspect: 'Active Yes-And-Ness',
        growing_up_stage: 'Archaic',
        divine_gender_polarity: 'Masculine',
        relationship_to_free_will: 'Deterministic',
        free_will_description: 'Pure instinct',
      }),
    ];
    mockList.mockResolvedValueOnce(apiStages);

    const { useStageStore } = require('../useStageStore');
    await act(async () => {
      await useStageStore.getState().fetchStages();
    });

    const stage = useStageStore.getState().stages[0];
    expect(stage.category).toBe('Survival');
    expect(stage.aspect).toBe('Active Yes-And-Ness');
    expect(stage.growingUpStage).toBe('Archaic');
    expect(stage.divineGenderPolarity).toBe('Masculine');
    expect(stage.relationshipToFreeWill).toBe('Deterministic');
    expect(stage.freeWillDescription).toBe('Pure instinct');
  });
});
