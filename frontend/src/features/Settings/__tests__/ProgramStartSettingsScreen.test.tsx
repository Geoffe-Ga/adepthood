import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ProgramStartSettingsScreen from '../ProgramStartSettingsScreen';

import DatePicker, { parseISODate } from '@/components/DatePicker';
import { TOTAL_PROGRAM_DAYS } from '@/constants/program';
import { useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import type { ProgramStartChangeOutcome } from '@/features/Habits/services/habitManager';
import type { ProgramStartOutcome } from '@/features/Program/programAnchor';
import { useHabitStore } from '@/store/useHabitStore';
import { useProgramStore } from '@/store/useProgramStore';
import { addDaysInTZ, todayInUserTZ } from '@/utils/dateUtils';

jest.mock('@/context/AuthContext', () => ({ useAuth: jest.fn() }));

const mockReconcile = jest.fn<(_tz: string) => Promise<void>>();
const mockCommitPassStart =
  jest.fn<(_day: string, _options: { tz: string }) => Promise<ProgramStartOutcome>>();
jest.mock('@/features/Program/programAnchor', () => ({
  reconcileProgramAnchor: (tz: string) => mockReconcile(tz),
  commitPassStart: (day: string, options: { tz: string }) => mockCommitPassStart(day, options),
}));

const mockChangeProgramStart =
  jest.fn<(_day: string, _tz?: string) => Promise<ProgramStartChangeOutcome>>();
/** The row write that follows a saved pass move (#3762); resolves whether it landed. */
const mockMovePassHabits = jest.fn<(_to: string, _tz?: string) => Promise<boolean>>();
const mockPassHabitsNotMoved =
  "Your next pass moved, but its habits' start dates didn't move with it. Check your connection and save again.";
jest.mock('@/features/Habits/services/habitManager', () => ({
  PASS_HABITS_NOT_MOVED_COPY: mockPassHabitsNotMoved,
  habitManager: {
    changeProgramStart: (day: string, tz?: string) => mockChangeProgramStart(day, tz),
    // The real order: the POST, then -- only once it saved -- the rows.
    movePendingPass: async (to: string, tz: string) => {
      const outcome = await mockCommitPassStart(to, { tz });
      if (outcome.kind !== 'saved') return outcome;
      return (await mockMovePassHabits(to, tz))
        ? outcome
        : { kind: 'rows_unsaved', message: mockPassHabitsNotMoved };
    },
    movePassHabits: (to: string, tz?: string) => mockMovePassHabits(to, tz),
  },
}));

jest.mock('@/storage/programStorage', () => ({
  loadProgramStartDate: jest.fn(() => Promise.resolve(null)),
  saveProgramStartDate: jest.fn(() => Promise.resolve()),
  clearProgramStartDate: jest.fn(() => Promise.resolve()),
}));

const ZONE = 'Europe/Paris';
const HELD_DAY = '2026-03-10';
// The served window reaches one whole program past today (#3725).
const TODAY = todayInUserTZ(ZONE);
const WINDOW = { earliest: '2026-01-02', latest: addDaysInTZ(TODAY, TOTAL_PROGRAM_DAYS, ZONE) };

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const hold = (locked = false) =>
  act(() =>
    useProgramStore.getState().adoptServerProgramStart({ day: HELD_DAY, window: WINDOW, locked }),
  );

/** How far ahead the next pass is held, how far a reschedule moves it, how far back a start-now reaches. */
const PENDING_DAYS_AHEAD = 16;
const MOVED_DAYS = 7;
const STARTED_DAYS_BACK = 3;
const PENDING_DAY = addDaysInTZ(TODAY, PENDING_DAYS_AHEAD, ZONE);
const PASS_WINDOW = { earliest: HELD_DAY, latest: WINDOW.latest };

/** A next pass held for ``PENDING_DAY`` behind the pass running since ``HELD_DAY``. */
const holdPending = (locked = false) =>
  act(() =>
    useProgramStore.getState().adoptServerProgramStart({
      day: HELD_DAY,
      window: locked ? null : WINDOW,
      locked,
      pass: { daysUntilStart: 0, pendingPassStartsOn: PENDING_DAY, passStartWindow: PASS_WINDOW },
    }),
  );

/** The POST's echo: a future day stays pending; a day that has come opens the pass now. */
const echoPass = (day: string): Promise<ProgramStartOutcome> => {
  const later = day > TODAY;
  useProgramStore.getState().adoptServerProgramStart({
    day: later ? HELD_DAY : day,
    window: WINDOW,
    locked: false,
    pass: {
      daysUntilStart: 0,
      pendingPassStartsOn: later ? day : null,
      passStartWindow: { earliest: later ? HELD_DAY : day, latest: WINDOW.latest },
    },
  });
  return Promise.resolve({ kind: 'saved' });
};

const picker = (result: ReturnType<typeof render>) =>
  result.UNSAFE_getByType(DatePicker).props as {
    value: string;
    minDate?: string;
    maxDate?: string;
    onChange: (_iso: string) => void;
  };

beforeEach(() => {
  mockUseAuth.mockReturnValue({ userTimezone: ZONE } as unknown as ReturnType<typeof useAuth>);
  mockReconcile.mockReset().mockResolvedValue(undefined);
  mockChangeProgramStart.mockReset().mockResolvedValue({ kind: 'saved' });
  mockCommitPassStart.mockReset().mockImplementation(echoPass);
  mockMovePassHabits.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  useHabitStore.setState({ habits: [] });
  useProgramStore.setState({
    programStartDay: null,
    programStartDate: null,
    anchorSource: null,
    programStartWindow: null,
    programStartLocked: false,
    pendingPassStartsOn: null,
    passStartWindow: null,
    daysUntilStart: 0,
  });
});

describe('ProgramStartSettingsScreen (#3097)', () => {
  it('re-reads the server anchor once, in the account zone', () => {
    render(<ProgramStartSettingsScreen />);

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(ZONE);
  });

  it('opens on the held date, clamped to the server window', () => {
    hold();

    const result = render(<ProgramStartSettingsScreen />);

    expect(result.getByTestId('program-start-settings-screen')).toBeTruthy();
    expect(picker(result)).toMatchObject({
      value: HELD_DAY,
      minDate: WINDOW.earliest,
      maxDate: WINDOW.latest,
    });
  });

  it('saves a new date through the habit-aware change and confirms it', async () => {
    hold();
    const result = render(<ProgramStartSettingsScreen />);

    act(() => picker(result).onChange('2026-04-01'));
    fireEvent.press(result.getByTestId('save-program-start-button'));

    await waitFor(() => expect(result.getByTestId('program-start-status')).toBeTruthy());
    expect(mockChangeProgramStart).toHaveBeenCalledWith('2026-04-01', ZONE);
  });

  it.each<[ProgramStartOutcome]>([
    [{ kind: 'refused', message: "That's before the earliest start date we can offer." }],
    [{ kind: 'unsaved', message: "Your start date didn't save." }],
  ])('shows why a pick did not take and keeps the held date (%j)', async (outcome) => {
    hold();
    mockChangeProgramStart.mockResolvedValueOnce(outcome);
    const result = render(<ProgramStartSettingsScreen />);

    act(() => picker(result).onChange('2026-04-01'));
    fireEvent.press(result.getByTestId('save-program-start-button'));

    await waitFor(() => expect(result.getByTestId('program-start-error')).toBeTruthy());
    expect(result.getByTestId('program-start-error')).toHaveTextContent(
      outcome.kind === 'saved' ? '' : outcome.message,
    );
    expect(picker(result).value).toBe(HELD_DAY);
  });

  it('never opens past the window, and saves its last day instead', async () => {
    const PAST_THE_END = 30;
    act(() =>
      useProgramStore.setState({
        programStartDay: addDaysInTZ(WINDOW.latest, PAST_THE_END, ZONE),
        anchorSource: 'storage',
        programStartWindow: WINDOW,
      }),
    );

    const result = render(<ProgramStartSettingsScreen />);

    expect(picker(result)).toMatchObject({ value: WINDOW.latest, maxDate: WINDOW.latest });
    fireEvent.press(result.getByTestId('save-program-start-button'));
    await waitFor(() => expect(mockChangeProgramStart).toHaveBeenCalledWith(WINDOW.latest, ZONE));
  });

  it('offers a future day in the first cycle, inside the window (#3728)', () => {
    hold();
    const result = render(<ProgramStartSettingsScreen />);
    const FUTURE_DAYS = 14;
    const future = addDaysInTZ(TODAY, FUTURE_DAYS, ZONE);

    act(() => picker(result).onChange(future));

    expect(picker(result).value).toBe(future);
    expect(picker(result).maxDate! > TODAY).toBe(true);
  });

  it('says the habits did not follow, not "saved", when only the date took (#3097 review)', async () => {
    const message = "Your new start date saved, but your habits' start dates didn't move to match.";
    hold();
    mockChangeProgramStart.mockImplementationOnce((day: string) => {
      act(() =>
        useProgramStore.getState().adoptServerProgramStart({ day, window: WINDOW, locked: false }),
      );
      return Promise.resolve({ kind: 'rows_unsaved', message });
    });
    const result = render(<ProgramStartSettingsScreen />);

    act(() => picker(result).onChange('2026-04-01'));
    fireEvent.press(result.getByTestId('save-program-start-button'));

    await waitFor(() =>
      expect(result.getByTestId('program-start-error')).toHaveTextContent(message),
    );
    expect(result.queryByTestId('program-start-status')).toBeNull();
    // The date did move, so the picker stays on it and Save re-lays the rows.
    expect(picker(result).value).toBe('2026-04-01');
    expect(result.getByTestId('current-program-start')).toHaveTextContent('April 1, 2026');
  });

  it('keeps the date fixed in a later cycle even though a new pass may still be opened (#3728)', () => {
    // Settings corrects the pass the person is in; opening one is the
    // scaffolding's, so the pass window served in every cycle unlocks nothing here.
    act(() =>
      useProgramStore.getState().adoptServerProgramStart({
        day: HELD_DAY,
        window: null,
        locked: true,
        pass: {
          daysUntilStart: 0,
          pendingPassStartsOn: null,
          passStartWindow: { earliest: HELD_DAY, latest: WINDOW.latest },
        },
      }),
    );

    const result = render(<ProgramStartSettingsScreen />);

    expect(result.UNSAFE_queryByType(DatePicker)).toBeNull();
    expect(result.getByText(/begin again/i)).toBeTruthy();
  });

  describe('while a next pass is pending (#3747)', () => {
    it("offers the pending pass's day in the pass window, never the running start", () => {
      holdPending();

      const result = render(<ProgramStartSettingsScreen />);

      expect(picker(result)).toMatchObject({
        value: PENDING_DAY,
        // The scaffold picker's floor rule: the day after the running start.
        minDate: addDaysInTZ(HELD_DAY, 1, 'UTC'),
        maxDate: PASS_WINDOW.latest,
      });
      expect(result.getByTestId('current-program-start')).toHaveTextContent('March 10, 2026');
      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        /^Your next pass begins /,
      );
      expect(result.queryByTestId('save-program-start-button')).toBeNull();
    });

    it('reschedules a later day with one POST and no PUT', async () => {
      holdPending();
      const result = render(<ProgramStartSettingsScreen />);
      const later = addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE);

      act(() => picker(result).onChange(later));
      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        /^Saving moves your next pass to /,
      );
      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      await waitFor(() =>
        expect(result.getByTestId('pending-pass-status')).toHaveTextContent(
          /^Saved\. Your next pass now begins /,
        ),
      );
      expect(mockCommitPassStart).toHaveBeenCalledTimes(1);
      expect(mockCommitPassStart).toHaveBeenCalledWith(later, { tz: ZONE });
      expect(mockChangeProgramStart).not.toHaveBeenCalled();
      expect(useProgramStore.getState().pendingPassStartsOn).toBe(later);
      expect(useProgramStore.getState().programStartDay).toBe(HELD_DAY);
    });

    it('says an earlier day starts the pass now, and starts it with the POST', async () => {
      holdPending();
      const result = render(<ProgramStartSettingsScreen />);
      const earlier = addDaysInTZ(TODAY, -STARTED_DAYS_BACK, ZONE);

      act(() => picker(result).onChange(earlier));
      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        /^Saving starts your next pass now, counted from .*; your current pass stays on Stats and progress\.$/,
      );
      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      await waitFor(() =>
        expect(result.getByTestId('current-program-start')).toHaveTextContent(
          parseISODate(earlier).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }),
        ),
      );
      expect(mockCommitPassStart).toHaveBeenCalledWith(earlier, { tz: ZONE });
      expect(mockChangeProgramStart).not.toHaveBeenCalled();
      // The pass has begun: nothing is pending, so the correction is offered again.
      expect(result.queryByTestId('save-pending-pass-button')).toBeNull();
      expect(result.getByTestId('program-start-status')).toHaveTextContent(
        /^Saved\. Your new pass has begun, counted from /,
      );
    });

    it('says today starts the pass today', () => {
      holdPending();
      const result = render(<ProgramStartSettingsScreen />);

      act(() => picker(result).onChange(TODAY));

      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        'Saving starts your next pass today; your current pass stays on Stats and progress.',
      );
    });

    it('sends nothing while the held day is unchanged', () => {
      holdPending();
      const result = render(<ProgramStartSettingsScreen />);

      const save = result.getByTestId('save-pending-pass-button');
      expect(save.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(save);

      expect(mockCommitPassStart).not.toHaveBeenCalled();
    });

    it('shows a refusal and puts the held day back', async () => {
      holdPending();
      mockCommitPassStart.mockResolvedValueOnce({ kind: 'refused', message: 'Too far ahead.' });
      const result = render(<ProgramStartSettingsScreen />);

      act(() => picker(result).onChange(addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE)));
      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      await waitFor(() =>
        expect(result.getByTestId('pending-pass-error')).toHaveTextContent('Too far ahead.'),
      );
      expect(picker(result).value).toBe(PENDING_DAY);
    });

    it('still offers the pending day in a later cycle, where opening a pass is allowed', () => {
      holdPending(true);

      const result = render(<ProgramStartSettingsScreen />);

      expect(picker(result).value).toBe(PENDING_DAY);
      expect(result.getByTestId('save-pending-pass-button')).toBeTruthy();
      expect(result.getByText(/begin again/i)).toBeTruthy();
    });
  });

  describe('the habits waiting for the pass move with it (#3762)', () => {
    /** A habit row starting on ``day`` in the account zone; locked unless ``revealed``. */
    const rowOn = (id: number, day: string, revealed = false): Habit => ({
      id,
      revealed,
      stage: 'Beige',
      name: `Habit ${id}`,
      icon: '✨',
      streak: 0,
      energy_cost: 5,
      energy_return: 5,
      start_date: `${day}T12:00:00Z` as unknown as Date,
      goals: [],
    });
    /** One unlocked habit of the running pass, and one locked habit waiting for the next. */
    const holdRows = () =>
      act(() =>
        useHabitStore.setState({ habits: [rowOn(1, HELD_DAY, true), rowOn(2, PENDING_DAY)] }),
      );

    it('says the waiting habits move too, and moves them once the POST saved', async () => {
      holdPending();
      holdRows();
      const result = render(<ProgramStartSettingsScreen />);
      const later = addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE);

      act(() => picker(result).onChange(later));
      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        /^Saving moves your next pass, and the habits waiting for it, to /,
      );
      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      await waitFor(() =>
        expect(result.getByTestId('pending-pass-status')).toHaveTextContent(
          /, and the habits waiting for it moved with it\.$/,
        ),
      );
      expect(mockCommitPassStart).toHaveBeenCalledTimes(1);
      expect(mockMovePassHabits).toHaveBeenCalledTimes(1);
      expect(mockMovePassHabits).toHaveBeenCalledWith(later, ZONE);
      expect(mockChangeProgramStart).not.toHaveBeenCalled();
    });

    it('moves the habits onto the day a start-now picks', async () => {
      holdPending();
      holdRows();
      const result = render(<ProgramStartSettingsScreen />);
      const earlier = addDaysInTZ(TODAY, -STARTED_DAYS_BACK, ZONE);

      act(() => picker(result).onChange(earlier));
      expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
        /, and moves the habits waiting for it to match; your current pass stays on Stats and progress\.$/,
      );
      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      await waitFor(() => expect(mockMovePassHabits).toHaveBeenCalledWith(earlier, ZONE));
    });

    it('moves no habit when the move is refused or never reaches the server', async () => {
      holdPending();
      holdRows();
      mockCommitPassStart
        .mockResolvedValueOnce({ kind: 'refused', message: 'Too far ahead.' })
        .mockResolvedValueOnce({ kind: 'unsaved', message: 'ignored' });
      const result = render(<ProgramStartSettingsScreen />);
      const later = addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE);

      act(() => picker(result).onChange(later));
      fireEvent.press(result.getByTestId('save-pending-pass-button'));
      await waitFor(() =>
        expect(result.getByTestId('pending-pass-error')).toHaveTextContent('Too far ahead.'),
      );
      act(() => picker(result).onChange(later));
      fireEvent.press(result.getByTestId('save-pending-pass-button'));
      await waitFor(() =>
        expect(result.getByTestId('pending-pass-error')).toHaveTextContent(/didn't save/),
      );

      expect(mockMovePassHabits).not.toHaveBeenCalled();
    });

    it('says the habits did not follow, and moves them on the next Save without a second POST', async () => {
      holdPending();
      holdRows();
      mockMovePassHabits.mockResolvedValueOnce(false);
      const result = render(<ProgramStartSettingsScreen />);
      const later = addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE);

      act(() => picker(result).onChange(later));
      fireEvent.press(result.getByTestId('save-pending-pass-button'));
      await waitFor(() =>
        expect(result.getByTestId('pending-pass-error')).toHaveTextContent(mockPassHabitsNotMoved),
      );
      const save = result.getByTestId('save-pending-pass-button');
      expect(save.props.accessibilityState).toMatchObject({ disabled: false });

      fireEvent.press(save);

      await waitFor(() =>
        expect(result.getByTestId('pending-pass-status')).toHaveTextContent(
          /and the habits waiting for it moved with it\.$/,
        ),
      );
      expect(mockCommitPassStart).toHaveBeenCalledTimes(1);
      expect(mockMovePassHabits).toHaveBeenLastCalledWith(later, ZONE);
    });

    it('offers the retry after a start-now whose habits did not follow', async () => {
      holdPending();
      holdRows();
      mockMovePassHabits.mockResolvedValueOnce(false);
      const result = render(<ProgramStartSettingsScreen />);

      act(() => picker(result).onChange(TODAY));
      fireEvent.press(result.getByTestId('save-pending-pass-button'));
      await waitFor(() =>
        expect(result.getByTestId('pending-pass-error')).toHaveTextContent(mockPassHabitsNotMoved),
      );
      // Nothing is pending now, but the correction is not offered over the owed rows.
      expect(result.queryByTestId('save-program-start-button')).toBeNull();

      fireEvent.press(result.getByTestId('save-pending-pass-button'));

      // Once they follow, the correction is offered again, under the same message.
      await waitFor(() =>
        expect(result.getByTestId('program-start-status')).toHaveTextContent(
          /^Saved\. Your new pass has begun, counted from .*, and the habits waiting for it moved with it\.$/,
        ),
      );
      expect(mockMovePassHabits).toHaveBeenLastCalledWith(TODAY, ZONE);
      expect(result.getByTestId('save-program-start-button')).toBeTruthy();
    });
  });

  it('promises only the pass when every habit is unlocked (#3762)', () => {
    holdPending();
    act(() =>
      useHabitStore.setState({
        habits: [
          {
            id: 1,
            stage: 'Beige',
            name: 'Kept',
            icon: '✨',
            streak: 0,
            energy_cost: 5,
            energy_return: 5,
            start_date: `${PENDING_DAY}T12:00:00Z` as unknown as Date,
            goals: [],
            revealed: true,
          },
        ],
      }),
    );
    const result = render(<ProgramStartSettingsScreen />);

    act(() => picker(result).onChange(addDaysInTZ(PENDING_DAY, MOVED_DAYS, ZONE)));

    expect(result.getByTestId('pending-pass-sentence')).toHaveTextContent(
      /^Saving moves your next pass to /,
    );
  });

  it('shows the fixed date and no picker once begin-again has run', () => {
    hold(true);

    const result = render(<ProgramStartSettingsScreen />);

    expect(result.UNSAFE_queryByType(DatePicker)).toBeNull();
    expect(result.queryByTestId('save-program-start-button')).toBeNull();
    expect(result.getByText(/begin again/i)).toBeTruthy();
  });

  it('invites a first pick without pressing for one when no date is held', () => {
    const result = render(<ProgramStartSettingsScreen />);

    expect(result.getByText(/haven.t picked a start date/i)).toBeTruthy();
    expect(picker(result).value).toBe(todayInUserTZ(ZONE));
  });
});
