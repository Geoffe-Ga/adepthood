import { describe, expect, it, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { StageData } from '../../features/Map/stageData';

const makeStage = (stageNumber: number, overrides: Partial<StageData> = {}): StageData => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: `Subtitle ${stageNumber}`,
  stageNumber,
  progress: 0,
  color: '#aaa',
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
  ...overrides,
});

describe('useStageStore', () => {
  beforeEach(() => {
    const { useStageStore } = require('../useStageStore');
    act(() => {
      useStageStore.getState().setStages([]);
      useStageStore.getState().setCurrentStage(1);
      useStageStore.getState().setLoading(false);
      useStageStore.getState().setError(null);
    });
  });

  it('starts with empty stages, no loading, no error', () => {
    const { useStageStore } = require('../useStageStore');
    const state = useStageStore.getState();
    expect(state.stages).toHaveLength(0);
    expect(state.stagesByNumber).toEqual({});
    expect(state.stageOrder).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('setStages normalizes into stagesByNumber and stageOrder', () => {
    const { useStageStore } = require('../useStageStore');
    const s1 = makeStage(1);
    const s2 = makeStage(2);

    act(() => useStageStore.getState().setStages([s2, s1]));

    const state = useStageStore.getState();
    expect(state.stageOrder).toEqual([2, 1]);
    expect(state.stagesByNumber[1]).toEqual(s1);
    expect(state.stagesByNumber[2]).toEqual(s2);
    expect(state.stages).toEqual([s2, s1]);
  });

  it('setCurrentStage updates the current stage number', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => useStageStore.getState().setCurrentStage(5));
    expect(useStageStore.getState().currentStage).toBe(5);
  });

  it('setLoading / setError update flags without touching stages', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => useStageStore.getState().setStages([makeStage(1)]));
    act(() => {
      useStageStore.getState().setLoading(true);
      useStageStore.getState().setError('boom');
    });
    const state = useStageStore.getState();
    expect(state.loading).toBe(true);
    expect(state.error).toBe('boom');
    expect(state.stages).toHaveLength(1);
  });

  it('updateStageProgress updates a specific stage progress', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => useStageStore.getState().setStages([makeStage(1, { progress: 0 })]));

    act(() => useStageStore.getState().updateStageProgress(1, 0.8));

    const state = useStageStore.getState();
    expect(state.stagesByNumber[1]!.progress).toBe(0.8);
    expect(state.stages[0]!.progress).toBe(0.8);
  });

  it('updateStageProgress is a no-op for an unknown stage', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => useStageStore.getState().setStages([makeStage(1, { progress: 0.5 })]));

    const before = useStageStore.getState().stages.map((s: StageData) => s.progress);
    act(() => useStageStore.getState().updateStageProgress(99, 1.0));
    const after = useStageStore.getState().stages.map((s: StageData) => s.progress);

    expect(after).toEqual(before);
  });

  it('selectStageByNumber returns a stage or undefined', () => {
    const { useStageStore, selectStageByNumber } = require('../useStageStore');
    act(() => useStageStore.getState().setStages([makeStage(3)]));
    const state = useStageStore.getState();

    expect(selectStageByNumber(3)(state)!.stageNumber).toBe(3);
    expect(selectStageByNumber(99)(state)).toBeUndefined();
    expect(selectStageByNumber(null)(state)).toBeUndefined();
    expect(selectStageByNumber(undefined)(state)).toBeUndefined();
  });

  // BUG-FE-STATE-001
  it('reset() restores the initial empty state', () => {
    const { useStageStore } = require('../useStageStore');
    act(() => {
      useStageStore.getState().setStages([makeStage(1), makeStage(2)]);
      useStageStore.getState().setCurrentStage(5);
      useStageStore.getState().setLoading(true);
      useStageStore.getState().setError('boom');
    });

    act(() => useStageStore.getState().reset());

    const state = useStageStore.getState();
    expect(state.stages).toEqual([]);
    expect(state.stagesByNumber).toEqual({});
    expect(state.stageOrder).toEqual([]);
    expect(state.currentStage).toBe(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('reset runs when resetAllStores is called', () => {
    const { useStageStore } = require('../useStageStore');
    const { resetAllStores } = require('../registry');
    act(() => useStageStore.getState().setStages([makeStage(7)]));
    act(() => resetAllStores());
    expect(useStageStore.getState().stages).toEqual([]);
  });
});
