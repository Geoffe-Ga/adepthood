import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { Stage, StageProgressRecord } from '../../../../api';
import { STAGE_COLORS, STAGE_ORDER, colors } from '../../../../design/tokens';
import type { useProgramStore as ProgramStore } from '../../../../store/useProgramStore';
import {
  BEGIN_AGAIN_FAILED_MESSAGE,
  MAP_LOAD_FAILED_MESSAGE,
  clampProgress,
  isStageUnlocked,
} from '../stageService';

/** Minimal shape of the GET /stages/program-calendar payload. */
interface ProgramCalendarPayload {
  program_started_at: string | null;
  calendar_stage: number;
  calendar_week: number;
  current_stage: number;
  cycle_number: number;
  program_start_window?: { earliest: string; latest: string } | null;
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
    spiral_dynamics_color: STAGE_ORDER[stageNumber - 1] ?? 'Beige',
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

  it('loadStages takes currentStage from the server program calendar', async () => {
    // The calendar has opened stage 4 while only stage 1 is complete. Counting
    // completions answers 2; the server answers 4, and the server is the only
    // one that knows what the record has entered.
    mockList.mockResolvedValueOnce([
      makeApiStage(1, { is_unlocked: true, progress: 1 }),
      makeApiStage(2, { is_unlocked: true, progress: 0.3 }),
      makeApiStage(3, { is_unlocked: true, progress: 0 }),
      makeApiStage(4, { is_unlocked: true, progress: 0 }),
    ]);
    mockProgramCalendar.mockResolvedValueOnce({
      program_started_at: '2026-01-01T00:00:00Z',
      calendar_stage: 4,
      calendar_week: 10,
      current_stage: 4,
      cycle_number: 1,
    });

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().currentStage).toBe(4);
  });

  it('loadStages honours a record that runs ahead of the completion count', async () => {
    // Nothing is complete, so a completion count answers 1; the server's
    // record says the person has entered stage 3 and that stands.
    mockList.mockResolvedValueOnce([makeApiStage(1), makeApiStage(2), makeApiStage(3)]);
    mockProgramCalendar.mockResolvedValueOnce({
      program_started_at: '2026-01-01T00:00:00Z',
      calendar_stage: 2,
      calendar_week: 5,
      current_stage: 3,
      cycle_number: 1,
    });

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().currentStage).toBe(3);
  });

  it('loadStages records an error message on API failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockList.mockRejectedValueOnce(new Error('Network error'));

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    const state = useStageStore.getState();
    // The person reads the Map's own sentence; the raw error text is for the console.
    expect(state.error).toBe(MAP_LOAD_FAILED_MESSAGE);
    expect(state.error).not.toContain('Network error');
    expect(consoleError).toHaveBeenCalledWith('map_load_failed');
    expect(state.loading).toBe(false);
    expect(state.stages).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('loadStages marks the attempt when the request resolves', async () => {
    mockList.mockResolvedValueOnce([makeApiStage(1)]);

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().hasAttempted).toBe(true);
  });

  it('loadStages marks the attempt when the request rejects', async () => {
    // Marking at request start, not on success: a failed load must count too.
    mockList.mockRejectedValueOnce(new Error('Network error'));

    const { stageService } = require('../stageService');
    const { useStageStore } = require('../../../../store/useStageStore');

    await act(async () => {
      await stageService.loadStages();
    });

    expect(useStageStore.getState().hasAttempted).toBe(true);
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

    it('leaves stages, cycleNumber and currentStage intact when the calendar fetch rejects', async () => {
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockRejectedValueOnce(new Error('calendar down'));
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      act(() => {
        useStageStore.getState().setCycleNumber(3);
        useStageStore.getState().setCurrentStage(5);
      });

      await act(async () => {
        await stageService.loadStages();
      });

      expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
      const state = useStageStore.getState();
      expect(state.stages).toHaveLength(1);
      expect(state.error).toBeNull();
      expect(state.cycleNumber).toBe(3);
      expect(state.currentStage).toBe(5);
    });
  });

  describe('stale responses', () => {
    /** A promise plus the resolve/reject handles, so a test drives when it settles. */
    function deferred<T>(): {
      promise: Promise<T>;
      resolve: (_value: T) => void;
      reject: (_error: Error) => void;
    } {
      let resolve: (_value: T) => void = () => undefined;
      let reject: (_error: Error) => void = () => undefined;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('drops a stage list that resolves after the store was reset', async () => {
      // Sign-out mid-flight: the previous account's stages must not repopulate
      // the freshly-emptied store when the slow request finally lands.
      const listCall = deferred<Stage[]>();
      mockList.mockReturnValueOnce(listCall.promise);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      let load: Promise<void> = Promise.resolve();
      act(() => {
        load = stageService.loadStages();
      });
      act(() => {
        useStageStore.getState().reset();
      });
      await act(async () => {
        listCall.resolve([makeApiStage(1), makeApiStage(2)]);
        await load;
      });

      const state = useStageStore.getState();
      expect(state.stages).toHaveLength(0);
      expect(state.hasAttempted).toBe(false);
      // A dropped response asks the server nothing further.
      expect(mockProgramCalendar).not.toHaveBeenCalled();
    });

    it('drops a failure that rejects after the store was reset', async () => {
      const listCall = deferred<Stage[]>();
      mockList.mockReturnValueOnce(listCall.promise);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      let load: Promise<void> = Promise.resolve();
      act(() => {
        load = stageService.loadStages();
      });
      act(() => {
        useStageStore.getState().reset();
      });
      await act(async () => {
        listCall.reject(new Error('Network error'));
        await load;
      });

      expect(useStageStore.getState().error).toBeNull();
    });

    it('drops a calendar response that resolves after the store was reset', async () => {
      const calendarCall = deferred<ProgramCalendarPayload>();
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockReturnValueOnce(calendarCall.promise);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      let load: Promise<void> = Promise.resolve();
      await act(async () => {
        load = stageService.loadStages();
        await Promise.resolve();
      });
      act(() => {
        useStageStore.getState().reset();
      });
      await act(async () => {
        calendarCall.resolve({
          program_started_at: null,
          calendar_stage: 7,
          calendar_week: 1,
          current_stage: 7,
          cycle_number: 4,
        });
        await load;
      });

      const state = useStageStore.getState();
      expect(state.currentStage).toBe(1);
      expect(state.cycleNumber).toBe(1);
    });

    it('settles on the newer load when an overtaken one resolves last', async () => {
      const first = deferred<Stage[]>();
      const second = deferred<Stage[]>();
      mockList.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      let older: Promise<void> = Promise.resolve();
      let newer: Promise<void> = Promise.resolve();
      act(() => {
        older = stageService.loadStages();
        newer = stageService.loadStages();
      });

      await act(async () => {
        second.resolve([makeApiStage(3, { progress: 0.75 })]);
        await newer;
      });
      await act(async () => {
        first.resolve([makeApiStage(1), makeApiStage(2)]);
        await older;
      });

      const state = useStageStore.getState();
      expect(state.stages).toHaveLength(1);
      expect(state.stages[0]!.stageNumber).toBe(3);
      expect(state.loading).toBe(false);
      // Only the winning load went on to ask for the calendar.
      expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
    });

    it('drops a begin-again response that resolves after the store was reset', async () => {
      const record = deferred<StageProgressRecord>();
      mockBeginAgainClient.mockReturnValueOnce(record.promise);
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      let again: Promise<void> = Promise.resolve();
      act(() => {
        again = stageService.beginAgain();
      });
      act(() => {
        useStageStore.getState().reset();
      });
      await act(async () => {
        record.resolve({
          id: 1,
          user_id: 42,
          current_stage: 1,
          completed_stages: [],
          cycle_number: 9,
        });
        await again;
      });

      expect(useStageStore.getState().cycleNumber).toBe(1);
      expect(mockList).not.toHaveBeenCalled();
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

    it.each([
      [1, 'exactly at the completion threshold'],
      [1.5, 'past the completion threshold'],
    ])(
      'returns true when currentStage is STAGE_COUNT and stage-10 progress is %s (%s)',
      (progress) => {
        const { isEndOfCycle } = require('../stageService');
        const stagesByNumber = makeStagesByNumber({ 10: { progress } });
        expect(isEndOfCycle(stagesByNumber, 10)).toBe(true);
      },
    );

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

  describe('highestCompletedStage', () => {
    it('returns 0 when no stage has reached full progress', () => {
      const { highestCompletedStage } = require('../stageService');
      expect(
        highestCompletedStage([
          { stageNumber: 1, progress: 0.9 },
          { stageNumber: 2, progress: 0 },
        ]),
      ).toBe(0);
    });

    it('returns 0 for an empty list', () => {
      const { highestCompletedStage } = require('../stageService');
      expect(highestCompletedStage([])).toBe(0);
    });

    it('returns the highest stage number whose progress is exactly complete', () => {
      const { highestCompletedStage } = require('../stageService');
      expect(
        highestCompletedStage([
          { stageNumber: 1, progress: 1 },
          { stageNumber: 3, progress: 1 },
          { stageNumber: 2, progress: 0.5 },
        ]),
      ).toBe(3);
    });

    it('counts progress past the completion threshold as complete', () => {
      const { highestCompletedStage } = require('../stageService');
      expect(highestCompletedStage([{ stageNumber: 4, progress: 1.2 }])).toBe(4);
    });

    it('ignores completed stages with a lower number than an earlier complete stage', () => {
      const { highestCompletedStage } = require('../stageService');
      expect(
        highestCompletedStage([
          { stageNumber: 5, progress: 1 },
          { stageNumber: 2, progress: 1 },
        ]),
      ).toBe(5);
    });
  });

  describe('toStageData manifestations mapping', () => {
    const sampleManifestations = [
      {
        phase: 'Rising',
        integrated: {
          name: 'Commitment',
          description: 'A grounded promise to begin showing up.',
        },
        shadow: { name: 'Overcommitment', description: 'Taking on too much too fast.' },
      },
    ];

    it('maps manifestations through unchanged', () => {
      const { toStageData } = require('../stageService');
      const apiStage = makeApiStage(1, { manifestations: sampleManifestations });

      const result = toStageData(apiStage);

      expect(result.manifestations).toEqual(sampleManifestations);
    });

    it('defaults manifestations to [] when the payload omits the field', () => {
      const { toStageData } = require('../stageService');
      const apiStage = makeApiStage(1);

      const result = toStageData(apiStage);

      expect(result.manifestations).toEqual([]);
    });
  });

  describe('toStageData mode and chord mapping', () => {
    const neitherBoth = {
      name: 'Be (Neither/Both)',
      description: 'Holds the healthy expression of all the other Modes.',
      holds_all_modes: true,
    };
    const chord = [{ phase: 'Rising', notes: [{ stage_number: 1, name: 'Commitment' }] }];

    it('maps mode and chord through unchanged', () => {
      const { toStageData } = require('../stageService');
      const result = toStageData(makeApiStage(10, { mode: neitherBoth, chord }));

      expect(result.mode).toEqual(neitherBoth);
      expect(result.chord).toEqual(chord);
    });

    it('defaults mode to null and chord to [] when the payload omits them', () => {
      const { toStageData } = require('../stageService');
      const result = toStageData(makeApiStage(1));

      expect(result.mode).toBeNull();
      expect(result.chord).toEqual([]);
    });
  });

  describe('toStageData colour (#2666)', () => {
    it('colours a stage from its served spiral_dynamics_color', () => {
      const { toStageData } = require('../stageService');
      // Stage 1 served as Teal: the offline fallback would say Beige, so only
      // a colour read from the served row lands on the Teal swatch.
      const result = toStageData(makeApiStage(1, { spiral_dynamics_color: 'Teal' }));

      expect(STAGE_ORDER[0]).not.toBe('Teal');
      expect(result.color).toBe(STAGE_COLORS.Teal);
    });

    it('resolves the legacy Turquoise alias to the Teal swatch', () => {
      const { toStageData } = require('../stageService');
      const result = toStageData(makeApiStage(8, { spiral_dynamics_color: 'Turquoise' }));

      expect(result.color).toBe(STAGE_COLORS.Teal);
    });

    it('falls back to the stage position when the served colour is blank', () => {
      const { toStageData } = require('../stageService');
      const result = toStageData(makeApiStage(2, { spiral_dynamics_color: '' }));

      expect(result.color).toBe(STAGE_COLORS.Purple);
    });

    it('takes the neutral token for a served colour the palette does not know', () => {
      const { toStageData } = require('../stageService');
      const result = toStageData(makeApiStage(2, { spiral_dynamics_color: 'Chartreuse' }));

      expect(result.color).toBe(colors.neutral);
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

    it.each([2, 3])('sets cycleNumber to the server-returned cycle_number %i', async (cycle) => {
      mockBeginAgainClient.mockResolvedValueOnce(makeProgressRecord(cycle));
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      // The reload's calendar fetch reports the same server-side cycle.
      mockProgramCalendar.mockResolvedValueOnce({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: cycle,
      });
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      await act(async () => {
        await stageService.beginAgain();
      });

      expect(useStageStore.getState().cycleNumber).toBe(cycle);
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
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockBeginAgainClient.mockRejectedValueOnce(new Error('boom'));
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');

      // The call site discards this promise, so a failure must not reject.
      await act(async () => {
        await expect(stageService.beginAgain()).resolves.toBeUndefined();
      });

      const state = useStageStore.getState();
      expect(typeof state.error).toBe('string');
      expect(state.error).toBe(BEGIN_AGAIN_FAILED_MESSAGE);
      expect(state.error).not.toContain('boom');
      expect(consoleError).toHaveBeenCalledWith('map_begin_again_failed');
      consoleError.mockRestore();
      // Failure short-circuits: no reload and no cycle bump from a bad response.
      expect(mockList).not.toHaveBeenCalled();
      expect(state.cycleNumber).toBe(1);
    });
  });

  describe("begin-again re-anchors the start day in the account's zone (#3702)", () => {
    const ACCOUNT_ZONE = 'America/Los_Angeles';
    // 03:00 UTC on 2026-11-09 is 19:00 PST on 2026-11-08: the zone decides the day.
    const NEW_CYCLE_STARTED_AT = '2026-11-09T03:00:00Z';
    const NEW_CYCLE_DAY_IN_ZONE = '2026-11-08';
    const PRIOR_CYCLE_DAY = '2026-01-05';
    const SECOND_CYCLE = 2;

    const secondCycleCalendar = (): ProgramCalendarPayload => ({
      program_started_at: NEW_CYCLE_STARTED_AT,
      calendar_stage: 1,
      calendar_week: 1,
      current_stage: 1,
      cycle_number: SECOND_CYCLE,
      program_start_window: null,
    });

    const progressRecord = (): StageProgressRecord => ({
      id: 1,
      user_id: 42,
      current_stage: 1,
      completed_stages: [],
      cycle_number: SECOND_CYCLE,
    });

    /** The program store, from the module registry this test's service resolves. */
    const programStore = () =>
      (require('../../../../store/useProgramStore') as { useProgramStore: typeof ProgramStore })
        .useProgramStore;

    /** Hold the first cycle's anchor, as the session reconcile left it. */
    const holdPriorCycleDay = (): void => {
      act(() =>
        programStore().getState().adoptServerProgramStart({
          day: PRIOR_CYCLE_DAY,
          window: null,
          locked: false,
        }),
      );
    };

    const flush = () => new Promise<void>((done) => setImmediate(done));

    it("adopts the new cycle's start day right after begin-again", async () => {
      mockBeginAgainClient.mockResolvedValueOnce(progressRecord());
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockResolvedValueOnce(secondCycleCalendar());
      const { stageService } = require('../stageService');
      holdPriorCycleDay();

      await act(async () => {
        await stageService.beginAgain(undefined, ACCOUNT_ZONE);
      });

      const program = programStore().getState();
      expect(program.programStartDay).toBe(NEW_CYCLE_DAY_IN_ZONE);
      expect(program.programStartLocked).toBe(true);
      // The UTC date is a day later, so the zone is what put the day here.
      expect(NEW_CYCLE_STARTED_AT.slice(0, 10)).not.toBe(NEW_CYCLE_DAY_IN_ZONE);
    });

    it('a plain loadStages leaves the anchor day alone', async () => {
      // Every other load passes no zone, so a first pick still held offline is
      // never overwritten by an ordinary Map visit.
      mockList.mockResolvedValueOnce([makeApiStage(1)]);
      mockProgramCalendar.mockResolvedValueOnce(secondCycleCalendar());
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      holdPriorCycleDay();

      await act(async () => {
        await stageService.loadStages();
      });

      const program = programStore().getState();
      expect(program.programStartDay).toBe(PRIOR_CYCLE_DAY);
      expect(program.programStartLocked).toBe(true);
      expect(useStageStore.getState().cycleNumber).toBe(SECOND_CYCLE);
    });

    it('a failed begin-again does not move the anchor day', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockBeginAgainClient.mockRejectedValueOnce(new Error('boom'));
      mockProgramCalendar.mockResolvedValue(secondCycleCalendar());
      const { stageService } = require('../stageService');
      holdPriorCycleDay();

      await act(async () => {
        await stageService.beginAgain(undefined, ACCOUNT_ZONE);
      });

      expect(mockProgramCalendar).not.toHaveBeenCalled();
      expect(programStore().getState().programStartDay).toBe(PRIOR_CYCLE_DAY);
      expect(consoleError).toHaveBeenCalledWith('map_begin_again_failed');
      consoleError.mockRestore();
    });

    it('a begin-again answered after a sign-out does not move the anchor day', async () => {
      let answer: (_record: StageProgressRecord) => void = () => {};
      mockBeginAgainClient.mockReturnValueOnce(
        new Promise<StageProgressRecord>((resolve) => {
          answer = resolve;
        }),
      );
      mockList.mockResolvedValue([makeApiStage(1)]);
      mockProgramCalendar.mockResolvedValue(secondCycleCalendar());
      const { stageService } = require('../stageService');
      const { useStageStore } = require('../../../../store/useStageStore');
      holdPriorCycleDay();

      let again: Promise<void> = Promise.resolve();
      act(() => {
        again = stageService.beginAgain(undefined, ACCOUNT_ZONE);
      });
      act(() => {
        useStageStore.getState().reset();
      });
      await act(async () => {
        answer(progressRecord());
        await again;
      });

      expect(mockProgramCalendar).not.toHaveBeenCalled();
      expect(programStore().getState().programStartDay).toBe(PRIOR_CYCLE_DAY);
    });

    it("a begin-again reload overtaken by a newer load does not adopt its stale calendar's day", async () => {
      let answerCalendar: (_calendar: ProgramCalendarPayload) => void = () => {};
      mockBeginAgainClient.mockResolvedValueOnce(progressRecord());
      mockList.mockResolvedValue([makeApiStage(1)]);
      mockProgramCalendar
        .mockReturnValueOnce(
          new Promise<ProgramCalendarPayload>((resolve) => {
            answerCalendar = resolve;
          }),
        )
        .mockResolvedValueOnce(secondCycleCalendar());
      const { stageService } = require('../stageService');
      holdPriorCycleDay();

      let again: Promise<void> = Promise.resolve();
      await act(async () => {
        again = stageService.beginAgain(undefined, ACCOUNT_ZONE);
        await flush();
      });
      expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
      await act(async () => {
        await stageService.loadStages();
      });
      await act(async () => {
        answerCalendar(secondCycleCalendar());
        await again;
      });

      expect(programStore().getState().programStartDay).toBe(PRIOR_CYCLE_DAY);
    });
  });
});
