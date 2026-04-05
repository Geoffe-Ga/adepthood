import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { StageData } from '../../features/Map/stageData';

describe('useStageStore', () => {
  beforeEach(() => {
    const { useStageStore } = require('../useStageStore');
    useStageStore.setState({
      stages: [],
      currentStage: 1,
    });
  });

  it('has correct initial state with default stages', () => {
    // Re-import to get fresh module with defaults
    jest.resetModules();
    const { useStageStore } = require('../useStageStore');
    const state = useStageStore.getState();

    expect(state.stages).toHaveLength(10);
    expect(state.currentStage).toBe(1);
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
        goals: [],
        practices: [],
        color: '#fff',
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
    jest.resetModules();
    const { useStageStore } = require('../useStageStore');

    act(() => useStageStore.getState().updateStageProgress(1, 0.8));

    const stage1 = useStageStore.getState().stages.find((s: StageData) => s.stageNumber === 1);
    expect(stage1!.progress).toBe(0.8);
  });

  it('updateStageProgress does nothing for unknown stage', () => {
    jest.resetModules();
    const { useStageStore } = require('../useStageStore');
    const before = useStageStore.getState().stages.map((s: StageData) => s.progress);

    act(() => useStageStore.getState().updateStageProgress(99, 1.0));

    const after = useStageStore.getState().stages.map((s: StageData) => s.progress);
    expect(after).toEqual(before);
  });
});
