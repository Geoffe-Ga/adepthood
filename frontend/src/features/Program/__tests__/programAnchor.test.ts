import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type * as ApiModule from '../../../api';
import { ApiError, type ProgramCalendar } from '../../../api';
import {
  loadPendingProgramStart,
  savePendingProgramStart,
} from '../../../storage/pendingProgramStart';
import { setActiveUser } from '../../../storage/userScope';
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
  holdPendingProgramStart,
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

/** A promise the test settles by hand, so it can choose which answer lands first. */
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

beforeEach(async () => {
  await AsyncStorage.clear();
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

describe('a late reconcile read never undoes a commit (#3097 review)', () => {
  const OLD_DAY_AT = '2026-09-01T04:00:00Z';

  it('drops a GET that was answered before a PUT whose echo has since been adopted', async () => {
    const stale = deferred<ProgramCalendar>();
    mockProgramCalendar.mockReturnValueOnce(stale.promise);
    mockSetProgramStart.mockResolvedValueOnce(calendar());

    const reading = reconcileProgramAnchor(ZONE);
    await flush();
    const outcome = await commitProgramStart(PICKED_DAY, { tz: ZONE });
    stale.resolve(calendar({ program_started_at: OLD_DAY_AT }));
    await reading;

    expect(outcome).toEqual({ kind: 'saved' });
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    expect(useProgramStore.getState().anchorSource).toBe('server');
  });

  it('still adopts a read that started after the commit landed', async () => {
    mockSetProgramStart.mockResolvedValueOnce(calendar());
    await commitProgramStart(PICKED_DAY, { tz: ZONE });
    mockProgramCalendar.mockResolvedValueOnce(calendar({ program_started_at: OLD_DAY_AT }));

    await reconcileProgramAnchor(ZONE);

    expect(useProgramStore.getState().programStartDay).toBe('2026-09-01');
  });
});

describe('a pick that never reached the server is sent again (#3097 review)', () => {
  // The server's default stamp is the moment its row was made (``now()``), not
  // a midnight: nobody chose it, so a held pick may still replace it.
  const SERVER_STAMP_AT = '2026-11-08T14:52:31Z';
  const held = (day: string = PICKED_DAY, priorServerDay: string | null = null) => ({
    owner: null,
    day,
    priorServerDay,
  });

  it('holds the pick on disk, with its owner and the server day it was made against', async () => {
    await holdPendingProgramStart({ owner: 7, day: PICKED_DAY, priorServerDay: null });

    await expect(loadPendingProgramStart()).resolves.toEqual({
      owner: 7,
      day: PICKED_DAY,
      priorServerDay: null,
    });
  });

  it("replays the held pick over the server's default stamp, and adopts the echo", async () => {
    await savePendingProgramStart(held());
    mockSetProgramStart.mockResolvedValueOnce(calendar());
    mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: SERVER_STAMP_AT }));

    await reconcileProgramAnchor(ZONE);

    expect(mockSetProgramStart).toHaveBeenCalledWith(PICKED_DAY, undefined);
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    expect(useProgramStore.getState().anchorSource).toBe('server');
    await expect(loadPendingProgramStart()).resolves.toBeNull();
  });

  it("keeps the pick, and does not adopt the server's stamp, while still offline", async () => {
    await savePendingProgramStart(held());
    useProgramStore.getState().setProgramStartDay(PICKED_DAY);
    mockSetProgramStart.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: SERVER_STAMP_AT }));

    await reconcileProgramAnchor(ZONE);

    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    expect(useProgramStore.getState().anchorSource).toBe('local');
    await expect(loadPendingProgramStart()).resolves.toEqual(held());
  });

  it('keeps the pick, and sends nothing, when the server cannot be read', async () => {
    await savePendingProgramStart(held());
    useProgramStore.getState().setProgramStartDay(PICKED_DAY);
    mockProgramCalendar.mockRejectedValue(new TypeError('Failed to fetch'));

    await reconcileProgramAnchor(ZONE);

    expect(mockSetProgramStart).not.toHaveBeenCalled();
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    await expect(loadPendingProgramStart()).resolves.toEqual(held());
  });

  it("lets a refused pick go and adopts the server's day", async () => {
    await savePendingProgramStart(held());
    mockSetProgramStart.mockRejectedValueOnce(new ApiError(422, 'program_start_too_early'));
    mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: SERVER_STAMP_AT }));

    await reconcileProgramAnchor(ZONE);

    expect(useProgramStore.getState().programStartDay).toBe('2026-11-08');
    await expect(loadPendingProgramStart()).resolves.toBeNull();
  });

  it('a later pick that saves supersedes the held one', async () => {
    await savePendingProgramStart(held('2026-10-01'));
    mockSetProgramStart.mockResolvedValueOnce(calendar());

    await commitProgramStart(PICKED_DAY, { tz: ZONE });

    await expect(loadPendingProgramStart()).resolves.toBeNull();
  });

  it('a log-out forgets the held pick', async () => {
    await savePendingProgramStart(held());

    useProgramStore.getState().reset();
    await flush();

    await expect(loadPendingProgramStart()).resolves.toBeNull();
  });

  describe('a held pick never overwrites a date chosen since (#3097 re-review)', () => {
    // Local midnight of 2026-11-02 in New York (EST, UTC-5): what the server
    // stores for a deliberate pick made on another device.
    const CHOSEN_ELSEWHERE_AT = '2026-11-02T05:00:00Z';

    it('drops the held pick and adopts a date picked on another device meanwhile', async () => {
      await savePendingProgramStart(held('2026-10-29'));
      mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: CHOSEN_ELSEWHERE_AT }));

      await reconcileProgramAnchor(ZONE);

      expect(mockSetProgramStart).not.toHaveBeenCalled();
      expect(useProgramStore.getState().programStartDay).toBe('2026-11-02');
      expect(useProgramStore.getState().anchorSource).toBe('server');
      await expect(loadPendingProgramStart()).resolves.toBeNull();
    });

    it('still replays when the server holds the very day it held when the pick was made', async () => {
      await savePendingProgramStart(held('2026-10-29', '2026-11-02'));
      mockSetProgramStart.mockResolvedValueOnce(calendar());
      mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: CHOSEN_ELSEWHERE_AT }));

      await reconcileProgramAnchor(ZONE);

      expect(mockSetProgramStart).toHaveBeenCalledWith('2026-10-29', undefined);
      await expect(loadPendingProgramStart()).resolves.toBeNull();
    });

    it('replays when the server has no anchor at all yet', async () => {
      await savePendingProgramStart(held());
      mockSetProgramStart.mockResolvedValueOnce(calendar());
      mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: null }));

      await reconcileProgramAnchor(ZONE);

      expect(mockSetProgramStart).toHaveBeenCalledWith(PICKED_DAY, undefined);
    });
  });

  describe('a held pick belongs to the account that made it (#3097 re-review)', () => {
    const OWNER = 41;
    const NEXT_ACCOUNT = 42;

    afterEach(() => {
      setActiveUser(null);
    });

    it("never PUTs another account's held pick, and lets it go", async () => {
      setActiveUser(NEXT_ACCOUNT);
      await savePendingProgramStart({ owner: OWNER, day: PICKED_DAY, priorServerDay: null });
      mockSetProgramStart.mockResolvedValue(calendar());
      mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: SERVER_STAMP_AT }));

      await reconcileProgramAnchor(ZONE);

      expect(mockSetProgramStart).not.toHaveBeenCalled();
      expect(useProgramStore.getState().programStartDay).toBe('2026-11-08');
      await expect(loadPendingProgramStart()).resolves.toBeNull();
    });

    it("replays the signed-in account's own held pick", async () => {
      setActiveUser(OWNER);
      await savePendingProgramStart({ owner: OWNER, day: PICKED_DAY, priorServerDay: null });
      mockSetProgramStart.mockResolvedValueOnce(calendar());
      mockProgramCalendar.mockResolvedValue(calendar({ program_started_at: SERVER_STAMP_AT }));

      await reconcileProgramAnchor(ZONE);

      expect(mockSetProgramStart).toHaveBeenCalledWith(PICKED_DAY, undefined);
    });
  });
});

describe('a commit that wrote nothing never drops a reconcile read (#3097 re-review)', () => {
  it.each([
    ['refused', new ApiError(409, 'program_start_fixed_after_first_cycle')],
    ['unsaved', new TypeError('Failed to fetch')],
  ])("adopts the server's answer after a %s commit", async (_kind, failure) => {
    const read = deferred<ProgramCalendar>();
    mockProgramCalendar.mockReturnValueOnce(read.promise);
    mockSetProgramStart.mockRejectedValueOnce(failure);

    const reading = reconcileProgramAnchor(ZONE);
    await flush();
    const outcome = await commitProgramStart('2026-10-01', { tz: ZONE });
    read.resolve(calendar());
    await reading;

    expect(outcome.kind).not.toBe('saved');
    expect(useProgramStore.getState().programStartDay).toBe(PICKED_DAY);
    expect(useProgramStore.getState().anchorSource).toBe('server');
    expect(useProgramStore.getState().programStartWindow).toEqual(WINDOW);
  });
});
