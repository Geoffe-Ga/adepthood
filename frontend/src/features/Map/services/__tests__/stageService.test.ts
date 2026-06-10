import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Stage } from '../../../../api';
import { clampProgress, isStageUnlocked } from '../stageService';

const mockList = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<Stage[]>>;
jest.mock('../../../../api', () => ({
  stages: { listAll: (...args: [string?]) => mockList(...args) },
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

describe('stageService', () => {
  beforeEach(() => {
    jest.resetModules();
    mockList.mockReset();
    const { useStageStore } = require('../../../../store/useStageStore');
    act(() => {
      useStageStore.getState().setStages([]);
      useStageStore.getState().setCurrentStage(1);
      useStageStore.getState().setLoading(false);
      useStageStore.getState().setError(null);
    });
  });

  it('loadStages writes sorted-descending StageData into the store', async () => {
    mockList.mockResolvedValueOnce([makeApiStage(1), makeApiStage(2), makeApiStage(3)]);

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    const state = useStageStore.getState();
    expect(state.stages).toHaveLength(3);
    expect(state.stages.map((s: { stageNumber: number }) => s.stageNumber)).toEqual([3, 2, 1]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('loadStages sets currentStage to completed_count + 1 (backend-truth mirror)', async () => {
    // BUG-FE-MAP-001: one completed (progress==1) stage → current is 2.
    // Matches the backend's `next_stage_for` under the chain-validation
    // invariant; no longer leaks the "highest unlocked" value when
    // `is_unlocked` runs ahead of actual completion.
    mockList.mockResolvedValueOnce([
      makeApiStage(1, { is_unlocked: true, progress: 1 }), // completed
      makeApiStage(2, { is_unlocked: true, progress: 0.3 }), // in progress
      makeApiStage(3, { is_unlocked: false, progress: 0 }),
    ]);

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().currentStage).toBe(2);
  });

  it('loadStages ignores is_unlocked drift and derives from completion count', async () => {
    // BUG-FE-MAP-001 regression: if the backend ever returned `is_unlocked`
    // for stages beyond the user's completion (e.g. from cached data or a
    // partially-applied migration) the old heuristic would jump currentStage
    // to the highest unlocked row.  Now it stays at completed_count + 1.
    mockList.mockResolvedValueOnce([
      makeApiStage(1, { is_unlocked: true, progress: 0.4 }),
      makeApiStage(2, { is_unlocked: true, progress: 0 }),
      makeApiStage(3, { is_unlocked: true, progress: 0 }),
    ]);

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().currentStage).toBe(1);
  });

  it('loadStages records an error message on API failure', async () => {
    mockList.mockRejectedValueOnce(new Error('Network error'));

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    const state = useStageStore.getState();
    expect(state.error).toBe('Network error');
    expect(state.loading).toBe(false);
    expect(state.stages).toHaveLength(0);
  });

  it('loadStages maps StageData metadata fields correctly', async () => {
    mockList.mockResolvedValueOnce([
      makeApiStage(1, {
        category: 'Survival',
        aspect: 'Active Yes-And-Ness',
        growing_up_stage: 'Archaic',
        divine_gender_polarity: 'Masculine',
        relationship_to_free_will: 'Deterministic',
        free_will_description: 'Pure instinct',
      }),
    ]);

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    const stage = useStageStore.getState().stages[0]!;
    expect(stage.category).toBe('Survival');
    expect(stage.aspect).toBe('Active Yes-And-Ness');
    expect(stage.growingUpStage).toBe('Archaic');
    expect(stage.divineGenderPolarity).toBe('Masculine');
    expect(stage.relationshipToFreeWill).toBe('Deterministic');
    expect(stage.freeWillDescription).toBe('Pure instinct');
  });

  it('loadStages forwards the optional token to the API client', async () => {
    mockList.mockResolvedValueOnce([]);
    const { stageService } = require('../stageService');

    await act(async () => {
      await stageService.loadStages('abc-token');
    });

    expect(mockList).toHaveBeenCalledWith('abc-token');
  });

  describe('advance-stage primitives (BUG-FE-MAP-005)', () => {
    it('prepareAdvanceStage returns null when next equals current', () => {
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => useStageStore.getState().setCurrentStage(3));

      expect(stageService.prepareAdvanceStage(3)).toBeNull();
    });

    it('apply / rollback restore the snapshot when commit fails', async () => {
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => useStageStore.getState().setCurrentStage(2));

      const ctx = stageService.prepareAdvanceStage(3);
      expect(ctx).toEqual({ prev: 2, next: 3 });

      stageService.applyAdvanceStage(ctx!);
      expect(useStageStore.getState().currentStage).toBe(3);

      // Simulate a commit failure: rollback restores prev.
      stageService.rollbackAdvanceStage(ctx!);
      expect(useStageStore.getState().currentStage).toBe(2);
    });

    it('commitAdvanceStage delegates to loadStages so the server reload reconciles', async () => {
      mockList.mockResolvedValueOnce([
        makeApiStage(1, { is_unlocked: true, progress: 1 }),
        makeApiStage(2, { is_unlocked: true, progress: 1 }),
        makeApiStage(3, { is_unlocked: true, progress: 0 }),
      ]);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      const ctx = { prev: 2, next: 3 };
      stageService.applyAdvanceStage(ctx);
      await act(async () => {
        await stageService.commitAdvanceStage(ctx);
      });

      // Server-derived currentStage = completed (2) + 1 = 3, matching the
      // optimistic value. If the server had only returned 2 completions
      // for stages 1 and 2 with stage-3 incomplete (progress 0), the
      // server's truth (3) confirms the optimistic write.
      expect(useStageStore.getState().currentStage).toBe(3);
    });

    it('rollbackAdvanceStage runs after a failed commit so the bumped stage reverts', async () => {
      mockList.mockRejectedValueOnce(new Error('still offline'));
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => useStageStore.getState().setCurrentStage(2));

      const ctx = stageService.prepareAdvanceStage(3)!;
      stageService.applyAdvanceStage(ctx);

      // commitAdvanceStage rethrows so `useOptimisticMutation` knows to
      // run rollback. `loadStages` swallows errors for background-
      // refresh ergonomics; this advance-specific commit path does not.
      await expect(
        act(async () => {
          await stageService.commitAdvanceStage(ctx);
        }),
      ).rejects.toThrow('still offline');
      stageService.rollbackAdvanceStage(ctx);

      expect(useStageStore.getState().currentStage).toBe(2);
      expect(useStageStore.getState().error).toBe('still offline');
    });
  });

  describe('clampProgress (BUG-FE-MAP-003)', () => {
    it('returns valid progress in [0, 1] unchanged', () => {
      expect(clampProgress(0)).toBe(0);
      expect(clampProgress(0.5)).toBe(0.5);
      expect(clampProgress(1)).toBe(1);
    });

    it('coerces NaN / Infinity / null / undefined to 0', () => {
      expect(clampProgress(Number.NaN)).toBe(0);
      expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
      expect(clampProgress(null)).toBe(0);
      expect(clampProgress(undefined)).toBe(0);
    });

    it('clamps negative values to 0 and values above 1 to 1', () => {
      expect(clampProgress(-0.5)).toBe(0);
      expect(clampProgress(1.1)).toBe(1);
      expect(clampProgress(42)).toBe(1);
    });
  });

  describe('isStageUnlocked (calendar alignment)', () => {
    it('honours the server flag when it is set', () => {
      expect(isStageUnlocked({ isUnlocked: true, stageNumber: 7 }, 1)).toBe(true);
    });

    it('unlocks stages at or below the date-derived current stage', () => {
      // Calendar says Purple (stage 2); the server still locks it.
      expect(isStageUnlocked({ isUnlocked: false, stageNumber: 2 }, 2)).toBe(true);
      expect(isStageUnlocked({ isUnlocked: false, stageNumber: 1 }, 2)).toBe(true);
    });

    it('keeps stages above the current stage locked', () => {
      expect(isStageUnlocked({ isUnlocked: false, stageNumber: 3 }, 2)).toBe(false);
    });

    it('falls back to the server flag when there is no calendar anchor', () => {
      expect(isStageUnlocked({ isUnlocked: false, stageNumber: 2 }, null)).toBe(false);
      expect(isStageUnlocked({ isUnlocked: true, stageNumber: 2 }, null)).toBe(true);
    });
  });
});
