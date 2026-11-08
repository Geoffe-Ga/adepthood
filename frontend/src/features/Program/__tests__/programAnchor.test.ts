import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type * as ApiModule from '../../../api';
import { ApiError, type ProgramCalendar } from '../../../api';
import {
  daysUntilStage,
  programStage,
  programWeek,
  useProgramStore,
} from '../../../store/useProgramStore';
import { useStageStore } from '../../../store/useStageStore';
import { adoptProgramCalendar } from '../adoptProgramCalendar';
import {
  commitProgramStart,
  PROGRAM_START_NOT_SAVED_COPY,
  reconcileProgramAnchor,
} from '../programAnchor';

const mockSetProgramStart = jest.fn<(_day: string, _token?: string) => Promise<ProgramCalendar>>();
const mockProgramCalendar = jest.fn<(_token?: string) => Promise<ProgramCalendar>>();
jest.mock('../../../api', () => {
  const actual = jest.requireActual<typeof ApiModule>('../../../api');
  return {
    ...actual,
    stages: {
      setProgramStart: (day: string, token?: string) => mockSetProgramStart(day, token),
      programCalendar: (token?: string) => mockProgramCalendar(token),
    },
  };
});

const mockLoadStages = jest.fn<(_token?: string) => Promise<void>>();
jest.mock('../../Map/services/stageService', () => ({
  stageService: { loadStages: (token?: string) => mockLoadStages(token) },
}));

jest.mock('../../../storage/programStorage', () => ({
  loadProgramStartDate: jest.fn(() => Promise.resolve(null)),
  saveProgramStartDate: jest.fn(() => Promise.resolve()),
  clearProgramStartDate: jest.fn(() => Promise.resolve()),
}));

const ZONE = 'America/New_York';
// 50 days back from a fixed "today": stage 3 (two 21-day stages have closed), week 8.
const PICKED_DAY = '2026-09-19';
const NOW = new Date('2026-11-08T15:00:00Z');
const PICKED_STAGE = 3;
const PICKED_WEEK = 8;
const WINDOW = { earliest: '2026-02-20', latest: '2026-11-08' };

const calendar = (overrides: Partial<ProgramCalendar> = {}): ProgramCalendar => ({
  // Local midnight of PICKED_DAY in New York (EDT, UTC-4).
  program_started_at: '2026-09-19T04:00:00Z',
  calendar_stage: PICKED_STAGE,
  calendar_week: PICKED_WEEK,
  current_stage: PICKED_STAGE,
  cycle_number: 1,
  program_start_window: WINDOW,
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockSetProgramStart.mockReset();
  mockProgramCalendar.mockReset();
  mockLoadStages.mockReset().mockResolvedValue(undefined);
  useProgramStore.getState().reset();
  useStageStore.getState().reset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('adoptProgramCalendar', () => {
  it('writes the server anchor, window and stage into both stores', () => {
    adoptProgramCalendar(calendar(), ZONE);

    const program = useProgramStore.getState();
    expect(program.programStartDay).toBe(PICKED_DAY);
    expect(program.programStartWindow).toEqual(WINDOW);
    expect(program.programStartLocked).toBe(false);
    expect(program.anchorSource).toBe('server');
    expect(useStageStore.getState().currentStage).toBe(PICKED_STAGE);
  });

  it('leaves the anchor untouched when the server has none yet', () => {
    useProgramStore.getState().setProgramStartDay('2026-11-01');

    adoptProgramCalendar(calendar({ program_started_at: null }), ZONE);

    expect(useProgramStore.getState().programStartDay).toBe('2026-11-01');
    expect(useProgramStore.getState().anchorSource).not.toBe('server');
  });

  it('marks a later cycle locked from the null window', () => {
    adoptProgramCalendar(calendar({ cycle_number: 2, program_start_window: null }), ZONE);

    expect(useProgramStore.getState().programStartLocked).toBe(true);
    expect(useStageStore.getState().cycleNumber).toBe(2);
  });

  it('adopts the window but not the day when no zone is known', () => {
    adoptProgramCalendar(calendar(), null);

    expect(useProgramStore.getState().programStartDay).toBeNull();
    expect(useProgramStore.getState().programStartWindow).toEqual(WINDOW);
  });
});

describe('the hydrate race', () => {
  it('a storage hydrate that resolves after the server answer does not overwrite it', () => {
    adoptProgramCalendar(calendar(), ZONE);

    useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 10, 1));

    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
  });
});

describe('commitProgramStart', () => {
  it('PUTs the day, adopts the echo and re-paces the Map', async () => {
    mockSetProgramStart.mockResolvedValue(calendar());

    const outcome = await commitProgramStart(PICKED_DAY, { tz: ZONE });

    expect(outcome).toEqual({ kind: 'saved' });
    expect(mockSetProgramStart).toHaveBeenCalledWith(PICKED_DAY, undefined);
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
  });

  it('one value drives every consumer after a single commit', async () => {
    mockSetProgramStart.mockResolvedValue(calendar());

    await commitProgramStart(PICKED_DAY, { tz: ZONE });

    const anchor = useProgramStore.getState().programStartDate;
    const today = new Date(2026, 10, 8);
    expect(programStage(anchor, today)).toBe(PICKED_STAGE);
    expect(programWeek(anchor, today)).toBe(PICKED_WEEK);
    expect(daysUntilStage(PICKED_STAGE, anchor, today)).toBeLessThanOrEqual(0);
    expect(daysUntilStage(PICKED_STAGE + 1, anchor, today)).toBeGreaterThan(0);
    expect(useStageStore.getState().currentStage).toBe(PICKED_STAGE);
  });

  it.each([
    [422, 'program_start_in_future', /today or earlier/i],
    [422, 'program_start_too_early', /earliest/i],
    [409, 'program_start_fixed_after_first_cycle', /begin again/i],
  ])('a %i %s is refused with plain copy and the store unchanged', async (status, code, copy) => {
    useProgramStore.getState().setProgramStartDay('2026-11-01');
    mockSetProgramStart.mockRejectedValue(new ApiError(status, code));

    const outcome = await commitProgramStart(PICKED_DAY, { tz: ZONE });

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind !== 'saved' && outcome.message).toMatch(copy);
    expect(useProgramStore.getState().programStartDay).toBe('2026-11-01');
    expect(mockLoadStages).not.toHaveBeenCalled();
  });

  it('a network failure keeps the previous anchor and says the date did not save', async () => {
    useProgramStore.getState().setProgramStartDay('2026-11-01');
    mockSetProgramStart.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await commitProgramStart(PICKED_DAY, { tz: ZONE });

    expect(outcome).toEqual({ kind: 'unsaved', message: PROGRAM_START_NOT_SAVED_COPY });
    expect(PROGRAM_START_NOT_SAVED_COPY).toMatch(/didn.t save/i);
    expect(useProgramStore.getState().programStartDay).toBe('2026-11-01');
  });
});

describe('reconcileProgramAnchor', () => {
  it('adopts the server anchor on one GET', async () => {
    mockProgramCalendar.mockResolvedValue(calendar());

    await reconcileProgramAnchor(ZONE);

    expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
  });

  it('swallows a failed read and keeps the cached anchor', async () => {
    useProgramStore.getState().setProgramStartDay('2026-11-01');
    mockProgramCalendar.mockRejectedValue(new TypeError('Failed to fetch'));

    await reconcileProgramAnchor(ZONE);

    expect(useProgramStore.getState().programStartDay).toBe('2026-11-01');
  });
});
