import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type * as ApiModule from '../../../api';
import { ApiError, type ProgramCalendar } from '../../../api';
import { beginAuthSession } from '../../../api/sessionToken';
import { programWeek, useProgramStore } from '../../../store/useProgramStore';
import { useStageStore } from '../../../store/useStageStore';
import { adoptProgramCalendar } from '../adoptProgramCalendar';
import { commitPassStart, PASS_START_NOT_SAVED_COPY } from '../programAnchor';

const mockOpenPass = jest.fn<(_day: string, _token?: string) => Promise<ProgramCalendar>>();
jest.mock('../../../api', () => {
  const actual = jest.requireActual<typeof ApiModule>('../../../api');
  return {
    ...actual,
    stages: { openPass: (day: string, token?: string) => mockOpenPass(day, token) },
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
const NOW = new Date('2026-11-15T15:00:00Z');
/** The running pass began here: local midnight in New York (EDT, UTC-4). */
const RUNNING_DAY = '2026-09-13';
const RUNNING_STARTED_AT = '2026-09-13T04:00:00Z';
/** Today, 2026-11-15, is in week 10 of the running pass. */
const RUNNING_WEEK = 10;
const FUTURE_DAY = '2026-12-01';
const PASS_WINDOW = { earliest: RUNNING_DAY, latest: '2027-07-25' };

const calendar = (overrides: Partial<ProgramCalendar> = {}): ProgramCalendar => ({
  program_started_at: RUNNING_STARTED_AT,
  calendar_stage: 4,
  calendar_week: RUNNING_WEEK,
  current_stage: 4,
  cycle_number: 2,
  program_start_window: null,
  days_until_start: 0,
  pending_pass_starts_on: null,
  pass_start_window: PASS_WINDOW,
  ...overrides,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockOpenPass.mockReset();
  mockLoadStages.mockReset().mockResolvedValue(undefined);
  useProgramStore.getState().reset();
  useStageStore.getState().reset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('adoptProgramCalendar: the pass a scaffolding save opens (#3728)', () => {
  it('adopts the countdown, the pending day and the pass window', () => {
    adoptProgramCalendar(
      calendar({ pending_pass_starts_on: FUTURE_DAY, days_until_start: 0 }),
      ZONE,
    );

    const program = useProgramStore.getState();
    expect(program.pendingPassStartsOn).toBe(FUTURE_DAY);
    expect(program.daysUntilStart).toBe(0);
    expect(program.passStartWindow).toEqual(PASS_WINDOW);
  });

  it('adopts a positive countdown for a first pass not yet begun', () => {
    const NOT_YET = 13;
    adoptProgramCalendar(
      calendar({
        program_started_at: '2026-11-28T05:00:00Z',
        cycle_number: 1,
        days_until_start: NOT_YET,
      }),
      ZONE,
    );

    expect(useProgramStore.getState().daysUntilStart).toBe(NOT_YET);
    expect(useProgramStore.getState().programStartDay).toBe('2026-11-28');
  });

  it('reads a calendar from before the fields existed as nothing pending', () => {
    useProgramStore.setState({ pendingPassStartsOn: FUTURE_DAY, daysUntilStart: 3 });

    adoptProgramCalendar(
      {
        program_started_at: RUNNING_STARTED_AT,
        calendar_stage: 4,
        calendar_week: RUNNING_WEEK,
        current_stage: 4,
        cycle_number: 1,
      },
      ZONE,
    );

    const program = useProgramStore.getState();
    expect(program.pendingPassStartsOn).toBeNull();
    expect(program.daysUntilStart).toBe(0);
    expect(program.passStartWindow).toBeNull();
  });

  it('keeps every reader on the running pass while the next one is pending', () => {
    adoptProgramCalendar(calendar({ pending_pass_starts_on: FUTURE_DAY }), ZONE);

    const { programStartDay, programStartDate } = useProgramStore.getState();
    expect(programStartDay).toBe(RUNNING_DAY);
    expect(programWeek(programStartDate, new Date(2026, 10, 15))).toBe(RUNNING_WEEK);
  });

  it('clears the pass fields on reset', () => {
    adoptProgramCalendar(calendar({ pending_pass_starts_on: FUTURE_DAY }), ZONE);

    useProgramStore.getState().reset();

    const program = useProgramStore.getState();
    expect(program.pendingPassStartsOn).toBeNull();
    expect(program.passStartWindow).toBeNull();
    expect(program.daysUntilStart).toBe(0);
  });
});

describe('commitPassStart (#3728)', () => {
  it('POSTs the day once, adopts the echo and re-paces the Map', async () => {
    mockOpenPass.mockResolvedValue(calendar({ pending_pass_starts_on: FUTURE_DAY }));

    const outcome = await commitPassStart(FUTURE_DAY, { tz: ZONE });

    expect(outcome).toEqual({ kind: 'saved' });
    expect(mockOpenPass).toHaveBeenCalledTimes(1);
    expect(mockOpenPass).toHaveBeenCalledWith(FUTURE_DAY, undefined);
    expect(useProgramStore.getState().pendingPassStartsOn).toBe(FUTURE_DAY);
    expect(useProgramStore.getState().programStartDay).toBe(RUNNING_DAY);
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
  });

  it.each([
    [422, 'program_start_in_future', /further ahead/i],
    [422, 'program_start_too_early', /earliest/i],
    [422, 'pass_start_before_current_pass', /before the pass you.re in/i],
  ])('a %i %s is refused with plain copy and the store unchanged', async (status, code, copy) => {
    adoptProgramCalendar(calendar(), ZONE);
    mockOpenPass.mockRejectedValue(new ApiError(status, code));

    const outcome = await commitPassStart(FUTURE_DAY, { tz: ZONE });

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind !== 'saved' && outcome.message).toMatch(copy);
    expect(useProgramStore.getState().pendingPassStartsOn).toBeNull();
    expect(mockLoadStages).not.toHaveBeenCalled();
  });

  it('a network failure leaves the running pass alone and says the pass did not open', async () => {
    adoptProgramCalendar(calendar(), ZONE);
    mockOpenPass.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await commitPassStart(FUTURE_DAY, { tz: ZONE });

    expect(outcome).toEqual({ kind: 'unsaved', message: PASS_START_NOT_SAVED_COPY });
    expect(PASS_START_NOT_SAVED_COPY).toMatch(/current pass/i);
    expect(useProgramStore.getState().programStartDay).toBe(RUNNING_DAY);
  });

  it('an echo that lands after the session ended is not adopted', async () => {
    let answer!: (_value: ProgramCalendar) => void;
    mockOpenPass.mockReturnValue(
      new Promise<ProgramCalendar>((settle) => {
        answer = settle;
      }),
    );

    const committing = commitPassStart(FUTURE_DAY, { tz: ZONE });
    beginAuthSession();
    answer(calendar({ pending_pass_starts_on: FUTURE_DAY }));
    await committing;

    expect(useProgramStore.getState().pendingPassStartsOn).toBeNull();
    expect(mockLoadStages).not.toHaveBeenCalled();
  });
});
