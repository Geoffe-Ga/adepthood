import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Stage, StageProgressRecord } from '../../../../api';
import { clampProgress, isStageUnlocked } from '../stageService';

/** Minimal shape of the GET /stages/program-calendar payload. */
interface ProgramCalendarPayload {
  program_started_at: string | null;
  calendar_stage: number;
  calendar_week: number;
  current_stage: number;
  cycle_number: number;
}

const mockList = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<Stage[]>>;
const mockBeginAgainClient = jest.fn() as jest.MockedFunction<() => Promise<StageProgressRecord>>;
const mockProgramCalendar = jest.fn() as jest.MockedFunction<
  (_token?: string) => Promise<ProgramCalendarPayload>
>;
jest.mock('../../../../api', () => ({
  stages: {
    listAll: (...args: [string?]) => mockList(...args),
    beginAgain: () => mockBeginAgainClient(),
    programCalendar: (...args: [string?]) => mockProgramCalendar(...args),
  },
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
    mockBeginAgainClient.mockReset();
    mockProgramCalendar.mockReset();
    mockProgramCalendar.mockResolvedValue({
      program_started_at: null,
      calendar_stage: 1,
      calendar_week: 1,
      current_stage: 1,
      cycle_number: 1,
    });
    const { useStageStore } = require('../../../../store/useStageStore');
    act(() => {
      useStageStore.getState().setStages([]);
      useStageStore.getState().setCurrentStage(1);
      useStageStore.getState().setLoading(false);
      useStageStore.getState().setError(null);
      useStageStore.getState().setCycleNumber(1);
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

  describe('loadStages cycle-number sync', () => {
    it('seeds cycleNumber from the program-calendar response', async () => {
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockResolvedValueOnce({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: 2,
      });
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      await act(async () => {
        await stageService.loadStages();
      });

      expect(useStageStore.getState().cycleNumber).toBe(2);
    });

    it('sets cycleNumber to 1 when the calendar reports cycle_number 1', async () => {
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockResolvedValueOnce({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: 1,
      });
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => {
        useStageStore.getState().setCycleNumber(4);
      });

      await act(async () => {
        await stageService.loadStages();
      });

      expect(useStageStore.getState().cycleNumber).toBe(1);
    });

    it('leaves stages and cycleNumber intact when the program-calendar fetch rejects', async () => {
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockRejectedValueOnce(new Error('calendar down'));
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => {
        useStageStore.getState().setCycleNumber(3);
      });

      await act(async () => {
        await stageService.loadStages();
      });

      expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
      const state = useStageStore.getState();
      expect(state.stages).toHaveLength(1);
      expect(state.error).toBeNull();
      expect(state.cycleNumber).toBe(3);
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

  describe('isEndOfCycle', () => {
    function makeStagesByNumber(
      overrides: Record<number, Partial<{ progress: number }>>,
    ): Record<number, { progress: number }> {
      const map: Record<number, { progress: number }> = {};
      for (let n = 1; n <= 10; n += 1) {
        map[n] = { progress: overrides[n]?.progress ?? 0 };
      }
      return map;
    }

    it('returns true when currentStage is STAGE_COUNT and stage-10 progress >= 1', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber = makeStagesByNumber({ 10: { progress: 1 } });
      expect(isEndOfCycle(stagesByNumber, 10)).toBe(true);
    });

    it('returns true when stage-10 progress is exactly 1.0 and currentStage is 10', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber = makeStagesByNumber({ 10: { progress: 1.0 } });
      expect(isEndOfCycle(stagesByNumber, 10)).toBe(true);
    });

    it('returns false when currentStage is 10 but stage-10 progress < 1', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber = makeStagesByNumber({ 10: { progress: 0.9 } });
      expect(isEndOfCycle(stagesByNumber, 10)).toBe(false);
    });

    it('returns false when stage-10 is complete but currentStage < STAGE_COUNT', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber = makeStagesByNumber({ 10: { progress: 1 } });
      expect(isEndOfCycle(stagesByNumber, 5)).toBe(false);
    });

    it('returns false mid-cycle (currentStage 3, nothing complete)', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber = makeStagesByNumber({});
      expect(isEndOfCycle(stagesByNumber, 3)).toBe(false);
    });

    it('returns false when stage-10 entry is absent from stagesByNumber', () => {
      const { isEndOfCycle } = require('../stageService');
      const stagesByNumber: Record<number, { progress: number }> = {};
      for (let n = 1; n <= 9; n += 1) {
        stagesByNumber[n] = { progress: 1 };
      }
      expect(isEndOfCycle(stagesByNumber, 10)).toBe(false);
    });
  });

  describe('beginAgain action', () => {
    function makeProgressRecord(cycleNumber: number): StageProgressRecord {
      return {
        id: 1,
        user_id: 42,
        current_stage: 1,
        completed_stages: [],
        cycle_number: cycleNumber,
      };
    }

    it('calls stages.beginAgain() on the API client', async () => {
      mockBeginAgainClient.mockResolvedValueOnce(makeProgressRecord(2));
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      const { stageService } = require('../stageService');

      await act(async () => {
        await stageService.beginAgain();
      });

      expect(mockBeginAgainClient).toHaveBeenCalledTimes(1);
    });

    it('sets cycleNumber from the response record', async () => {
      mockBeginAgainClient.mockResolvedValueOnce(makeProgressRecord(2));
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      // The reload's calendar fetch reports the same server-side cycle.
      mockProgramCalendar.mockResolvedValueOnce({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: 2,
      });
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      await act(async () => {
        await stageService.beginAgain();
      });

      expect(useStageStore.getState().cycleNumber).toBe(2);
    });

    it('reloads stages after setting cycleNumber', async () => {
      mockBeginAgainClient.mockResolvedValueOnce(makeProgressRecord(2));
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      const { stageService } = require('../stageService');

      await act(async () => {
        await stageService.beginAgain();
      });

      expect(mockList).toHaveBeenCalledTimes(1);
    });

    it('routes a failed begin-again to the store error without rejecting', async () => {
      mockBeginAgainClient.mockRejectedValueOnce(new Error('boom'));
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      // The call site discards this promise, so a failure must not reject.
      await act(async () => {
        await expect(stageService.beginAgain()).resolves.toBeUndefined();
      });

      const state = useStageStore.getState();
      expect(typeof state.error).toBe('string');
      expect(state.error).toBe('boom');
      // Failure short-circuits: no reload and no cycle bump from a bad response.
      expect(mockList).not.toHaveBeenCalled();
      expect(state.cycleNumber).toBe(1);
    });

    it('reflects cycle_number 3 when the server returns it', async () => {
      mockBeginAgainClient.mockResolvedValueOnce(makeProgressRecord(3));
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      // The reload's calendar fetch reports the same server-side cycle.
      mockProgramCalendar.mockResolvedValueOnce({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: 3,
      });
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      await act(async () => {
        await stageService.beginAgain();
      });

      expect(useStageStore.getState().cycleNumber).toBe(3);
    });
  });
});
