import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useHabitStore } from '../../../store/useHabitStore';
import { useProgramStore } from '../../../store/useProgramStore';
import type { Habit } from '../../Habits/Habits.types';
import type { ProgramStartOutcome } from '../programAnchor';
import { usePendingPassPick } from '../usePendingPassPick';

jest.mock('../../../storage/programStorage', () => ({
  loadProgramStartDate: jest.fn(() => Promise.resolve(null)),
  saveProgramStartDate: jest.fn(() => Promise.resolve()),
  clearProgramStartDate: jest.fn(() => Promise.resolve()),
}));

const mockCommitPassStart =
  jest.fn<(_day: string, _options: { tz: string }) => Promise<ProgramStartOutcome>>();
jest.mock('../programAnchor', () => ({
  commitPassStart: (day: string, options: { tz: string }) => mockCommitPassStart(day, options),
}));

type ChangeOutcome = ProgramStartOutcome | { kind: 'rows_unsaved'; message: string };
/** The habits waiting for the pass move with it (#3762): the POST, then -- once saved -- the rows. */
const mockMovePendingPass = jest.fn<(_to: string, _tz?: string) => Promise<ChangeOutcome>>();
const mockMovePassHabits = jest.fn<(_to: string, _tz?: string) => Promise<boolean>>();
jest.mock('../../Habits/services/habitManager', () => ({
  PASS_HABITS_NOT_MOVED_COPY: 'Your next pass moved, but its habits did not.',
  habitManager: {
    movePendingPass: (to: string, tz?: string) => mockMovePendingPass(to, tz),
    movePassHabits: (to: string, tz?: string) => mockMovePassHabits(to, tz),
  },
}));

const ZONE = 'America/New_York';
// Noon in New York on 2026-11-15.
const NOW = new Date('2026-11-15T17:00:00Z');
const RUNNING_DAY = '2026-09-13';
const HELD = '2026-12-01';
const LATEST = '2027-09-13';

const holdPending = (pending: string | null = HELD, earliest = RUNNING_DAY) =>
  act(() =>
    useProgramStore.getState().adoptServerProgramStart({
      day: RUNNING_DAY,
      window: { earliest: '2026-01-02', latest: LATEST },
      locked: false,
      pass: {
        daysUntilStart: 0,
        pendingPassStartsOn: pending,
        passStartWindow: { earliest, latest: LATEST },
      },
    }),
  );

/** The server's echo of a POST: a future day is held, an earlier one opens now. */
const echo = (day: string): Promise<ProgramStartOutcome> => {
  const later = day > '2026-11-15';
  act(() =>
    useProgramStore.getState().adoptServerProgramStart({
      day: later ? RUNNING_DAY : day,
      window: { earliest: '2026-01-02', latest: LATEST },
      locked: false,
      pass: {
        daysUntilStart: 0,
        pendingPassStartsOn: later ? day : null,
        passStartWindow: { earliest: later ? RUNNING_DAY : day, latest: LATEST },
      },
    }),
  );
  return Promise.resolve({ kind: 'saved' });
};

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockCommitPassStart.mockReset().mockImplementation(echo);
  mockMovePendingPass
    .mockReset()
    .mockImplementation((to, tz) => mockCommitPassStart(to, { tz: tz ?? ZONE }));
  mockMovePassHabits.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  act(() => useProgramStore.getState().reset());
  act(() => useHabitStore.setState({ habits: [] }));
  jest.useRealTimers();
});

describe('usePendingPassPick (#3747)', () => {
  it('offers the held day inside the pass window, the running start excluded', () => {
    holdPending();

    const { result } = renderHook(() => usePendingPassPick(ZONE));

    expect(result.current.held).toBe(HELD);
    expect(result.current.day).toBe(HELD);
    // The floor rule of the scaffold picker: never the running pass's own start.
    expect(result.current.range.minDay).toBe('2026-09-14');
    expect(result.current.range.maxDay).toBe(LATEST);
    expect(result.current.changed).toBe(false);
    expect(result.current.sentence).toBe('Your next pass begins December 1, 2026.');
  });

  it('holds nothing to offer when no pass is pending', () => {
    holdPending(null);

    const { result } = renderHook(() => usePendingPassPick(ZONE));

    expect(result.current.held).toBeNull();
  });

  it('sends nothing for an unchanged day', async () => {
    holdPending();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(outcome).toEqual({ kind: 'unchanged' });
    expect(mockCommitPassStart).not.toHaveBeenCalled();
  });

  it('reschedules to a later day through POST /stages/passes and says so first', async () => {
    holdPending();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));
    expect(result.current.sentence).toBe('Saving moves your next pass to December 20, 2026.');
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(mockCommitPassStart).toHaveBeenCalledWith('2026-12-20', { tz: ZONE });
    expect(outcome).toEqual({
      kind: 'saved',
      message: 'Saved. Your next pass now begins December 20, 2026.',
    });
    expect(result.current.held).toBe('2026-12-20');
    expect(result.current.changed).toBe(false);
  });

  it('starts the pass now on an earlier day, and says so first', async () => {
    holdPending();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-11-10'));
    expect(result.current.sentence).toMatch(/^Saving starts your next pass now/);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(mockCommitPassStart).toHaveBeenCalledWith('2026-11-10', { tz: ZONE });
    expect(outcome).toEqual({
      kind: 'saved',
      message: 'Saved. Your new pass has begun, counted from November 10, 2026.',
    });
    expect(useProgramStore.getState().pendingPassStartsOn).toBeNull();
  });

  it('puts the held day back on a refusal and passes the server copy on', async () => {
    holdPending();
    mockCommitPassStart.mockResolvedValueOnce({ kind: 'refused', message: 'Too far ahead.' });
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(outcome).toEqual({ kind: 'refused', message: 'Too far ahead.' });
    expect(result.current.day).toBe(HELD);
  });

  it('says the held day still stands when the save never reached the server', async () => {
    holdPending();
    mockCommitPassStart.mockResolvedValueOnce({ kind: 'unsaved', message: 'ignored' });
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(outcome).toEqual({
      kind: 'unsaved',
      message:
        "Your next pass's day didn't save. Check your connection and save again; it still begins December 1, 2026.",
    });
    expect(result.current.day).toBe(HELD);
  });

  it('goes back to the held day on reset', () => {
    holdPending();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));
    act(() => result.current.reset());

    expect(result.current.day).toBe(HELD);
    expect(result.current.changed).toBe(false);
  });
});

/** A habit row starting on ``day`` (a New York midnight); locked unless ``revealed``. */
const rowOn = (id: number, day: string, revealed = false): Habit => ({
  revealed,
  id,
  stage: 'Beige',
  name: `Habit ${id}`,
  icon: '✨',
  streak: 0,
  energy_cost: 5,
  energy_return: 5,
  start_date: new Date(`${day}T05:00:00Z`),
  goals: [],
});

describe('the habits waiting for the pass move with it (#3762)', () => {
  /** One unlocked habit of the running pass, and two locked ones waiting for the next. */
  const holdPassRows = () =>
    act(() =>
      useHabitStore.setState({
        habits: [rowOn(1, RUNNING_DAY, true), rowOn(2, HELD), rowOn(3, '2026-12-22')],
      }),
    );

  it('says the waiting habits move too, when the pass has any', () => {
    holdPending();
    holdPassRows();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));

    expect(result.current.sentence).toBe(
      'Saving moves your next pass, and the habits waiting for it, to December 20, 2026.',
    );
  });

  it('says only the pass moves when every habit is unlocked, whatever its date', () => {
    holdPending();
    act(() =>
      useHabitStore.setState({ habits: [rowOn(1, RUNNING_DAY, true), rowOn(2, HELD, true)] }),
    );
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-20'));

    expect(result.current.sentence).toBe('Saving moves your next pass to December 20, 2026.');
  });

  it('moves the pass and its waiting habits through the habit manager', async () => {
    holdPending();
    holdPassRows();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-22'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.commit();
    });

    expect(mockMovePendingPass).toHaveBeenCalledWith('2026-12-22', ZONE);
    expect(mockCommitPassStart).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: 'saved',
      message:
        'Saved. Your next pass now begins December 22, 2026, and the habits waiting for it moved with it.',
    });
  });

  it('starts the pass now and moves its habits onto that day', async () => {
    holdPending();
    holdPassRows();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-11-15'));
    await act(async () => {
      await result.current.commit();
    });

    expect(mockMovePendingPass).toHaveBeenCalledWith('2026-11-15', ZONE);
  });

  it('sends only the POST when the caller writes the rows itself', async () => {
    holdPending();
    holdPassRows();
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-22'));
    await act(async () => {
      await result.current.commit({ moveHabits: false });
    });

    expect(mockCommitPassStart).toHaveBeenCalledWith('2026-12-22', { tz: ZONE });
    expect(mockMovePendingPass).not.toHaveBeenCalled();
    expect(mockMovePassHabits).not.toHaveBeenCalled();
  });

  it('owes the rows when the pass moved but they did not, and moves them on the next save', async () => {
    holdPending();
    holdPassRows();
    mockMovePendingPass.mockImplementationOnce(async (to, tz) => {
      await mockCommitPassStart(to, { tz: tz ?? ZONE });
      return { kind: 'rows_unsaved', message: 'Your next pass moved, but its habits did not.' };
    });
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-22'));
    let first: unknown;
    await act(async () => {
      first = await result.current.commit();
    });

    expect(first).toEqual({
      kind: 'rows_unsaved',
      message: 'Your next pass moved, but its habits did not.',
    });
    expect(result.current.held).toBe('2026-12-22');
    // Nothing new is picked, yet saving still has the rows to send.
    expect(result.current.owed).toBe(true);
    expect(result.current.changed).toBe(true);

    let retry: unknown;
    await act(async () => {
      retry = await result.current.commit();
    });

    expect(mockMovePassHabits).toHaveBeenCalledWith('2026-12-22', ZONE);
    expect(mockCommitPassStart).toHaveBeenCalledTimes(1);
    expect(retry).toEqual({
      kind: 'saved',
      message:
        'Saved. Your next pass now begins December 22, 2026, and the habits waiting for it moved with it.',
    });
    expect(result.current.owed).toBe(false);
  });

  it('moves the owed rows to the newest day when another day is picked', async () => {
    holdPending();
    holdPassRows();
    mockMovePendingPass.mockImplementationOnce(async (to, tz) => {
      await mockCommitPassStart(to, { tz: tz ?? ZONE });
      return { kind: 'rows_unsaved', message: 'not moved' };
    });
    const { result } = renderHook(() => usePendingPassPick(ZONE));
    act(() => result.current.pick('2026-12-22'));
    await act(async () => {
      await result.current.commit();
    });

    act(() => result.current.pick('2026-12-29'));
    await act(async () => {
      await result.current.commit();
    });

    expect(mockMovePendingPass).toHaveBeenLastCalledWith('2026-12-29', ZONE);
  });

  it('leaves the rows alone on a refusal', async () => {
    holdPending();
    holdPassRows();
    mockCommitPassStart.mockResolvedValueOnce({ kind: 'refused', message: 'No.' });
    const { result } = renderHook(() => usePendingPassPick(ZONE));

    act(() => result.current.pick('2026-12-22'));
    await act(async () => {
      await result.current.commit();
    });

    expect(mockMovePassHabits).not.toHaveBeenCalled();
    expect(result.current.owed).toBe(false);
  });
});
