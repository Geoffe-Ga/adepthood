import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ProgramStartSettingsScreen from '../ProgramStartSettingsScreen';

import DatePicker from '@/components/DatePicker';
import { TOTAL_PROGRAM_DAYS } from '@/constants/program';
import { useAuth } from '@/context/AuthContext';
import type { ProgramStartChangeOutcome } from '@/features/Habits/services/habitManager';
import type { ProgramStartOutcome } from '@/features/Program/programAnchor';
import { useProgramStore } from '@/store/useProgramStore';
import { addDaysInTZ, todayInUserTZ } from '@/utils/dateUtils';

jest.mock('@/context/AuthContext', () => ({ useAuth: jest.fn() }));

const mockReconcile = jest.fn<(_tz: string) => Promise<void>>();
jest.mock('@/features/Program/programAnchor', () => ({
  reconcileProgramAnchor: (tz: string) => mockReconcile(tz),
}));

const mockChangeProgramStart =
  jest.fn<(_day: string, _tz?: string) => Promise<ProgramStartChangeOutcome>>();
jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    changeProgramStart: (day: string, tz?: string) => mockChangeProgramStart(day, tz),
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
});

afterEach(() => {
  useProgramStore.setState({
    programStartDay: null,
    programStartDate: null,
    anchorSource: null,
    programStartWindow: null,
    programStartLocked: false,
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
