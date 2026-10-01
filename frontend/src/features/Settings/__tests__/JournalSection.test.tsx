import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import JournalSection from '../JournalSection';

import type { UiFlags, UiFlagsUpdate } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import {
  OFFER_AGAIN_DESCRIPTION,
  OFFER_AGAIN_DONE,
  OFFER_AGAIN_LABEL,
  WRITING_TIMER_ROW_LINKED_PENDING,
  WRITING_TIMER_ROW_UNLINKED,
  writingTimerRowLabel,
} from '@/features/Journal/saveAsHabitCopy';
import { useHabitStore } from '@/store/useHabitStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const mockFlagsGet = jest.fn<(_token?: string) => Promise<UiFlags>>();
const mockFlagsUpdate = jest.fn<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>();
const mockLoadHabits = jest.fn<(_tz?: string) => Promise<void>>();
const mockSaveAnswered = jest.fn<(_value: boolean) => Promise<void>>();

jest.mock('@/api', () => ({
  uiFlags: {
    get: (token?: string) => mockFlagsGet(token),
    update: (partial: UiFlagsUpdate, token?: string) => mockFlagsUpdate(partial, token),
  },
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'settings-tok', userTimezone: 'Europe/Lisbon' }),
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: { loadHabits: (tz?: string) => mockLoadHabits(tz) },
}));

jest.mock('@/storage/writingOfferStorage', () => ({
  saveWritingOfferAnswered: (value: boolean) => mockSaveAnswered(value),
}));

const ladder = (): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
    id: 200 + index,
    title: tier,
    tier,
    target: index + 1,
    target_unit: 'pages',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  }));

const habit = (id: number, name: string): Habit => ({
  id,
  stage: 'Beige',
  name,
  icon: '•',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2025-01-01'),
  goals: ladder(),
  completions: [],
  revealed: true,
});

const HABITS = [habit(31, 'Morning pages'), habit(32, 'Stretch')];

const flags = (habitId: number | null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: habitId,
  practice_session_habit_id: null,
});

const rowLabel = (view: ReturnType<typeof render>): string =>
  view.getByTestId('settings-row-writing-habit').props.accessibilityLabel as string;

beforeEach(() => {
  jest.clearAllMocks();
  useWritingHabitLinkStore.getState().reset();
  useHabitStore.getState().setHabits(HABITS);
  mockFlagsGet.mockResolvedValue(flags(null));
  mockFlagsUpdate.mockImplementation((partial) =>
    Promise.resolve(flags(partial.writing_session_habit_id ?? null)),
  );
  mockLoadHabits.mockResolvedValue(undefined);
  mockSaveAnswered.mockResolvedValue(undefined);
});

describe('JournalSection — the writing timer row', () => {
  it('is its own "Journal" group, and reads the link from the server on mount', async () => {
    const view = render(<JournalSection />);

    expect(view.getByTestId('settings-group-journal')).toBeTruthy();
    expect(view.getByText('Journal')).toBeTruthy();
    await waitFor(() => expect(mockFlagsGet).toHaveBeenCalledWith('settings-tok'));
  });

  it('says "not linked" when the server holds no link', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));

    expect(rowLabel(view)).toBe(WRITING_TIMER_ROW_UNLINKED);
  });

  it('names the linked habit by its own name', async () => {
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<JournalSection />);

    await waitFor(() => expect(rowLabel(view)).toBe(writingTimerRowLabel('Stretch')));
    expect(view.getByText('Writing timer → Stretch')).toBeTruthy();
  });

  it('says a linked habit that is locked is paused, rather than implying it is checked off', async () => {
    useHabitStore.getState().setHabits([{ ...habit(32, 'Stretch'), revealed: false }]);
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<JournalSection />);

    await waitFor(() =>
      expect(rowLabel(view)).toBe('Writing timer → Stretch · paused while locked'),
    );
  });

  it('never says "not linked" for a link whose habit has not been read yet, and reads it', async () => {
    useHabitStore.getState().setHabits([]);
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<JournalSection />);

    await waitFor(() => expect(rowLabel(view)).toBe(WRITING_TIMER_ROW_LINKED_PENDING));
    await waitFor(() => expect(mockLoadHabits).toHaveBeenCalledWith('Europe/Lisbon'));

    act(() => useHabitStore.getState().setHabits(HABITS));
    expect(rowLabel(view)).toBe(writingTimerRowLabel('Stretch'));
  });

  it('opens the shared picker, and choosing a habit links it and closes the picker', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));
    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
    expect(view.queryByTestId('writing-habit-new')).toBeNull();
    expect(view.queryByTestId('writing-habit-clear')).toBeNull();

    fireEvent.press(view.getByTestId('writing-habit-choose-31'));

    // Asserted on the testID rather than the element: a failing match on a host
    // element pretty-prints its whole fiber, which alone outlasts ``waitFor``.
    await waitFor(() =>
      expect(view.queryByTestId('writing-habit-picker')?.props.testID).toBeUndefined(),
    );
    expect(mockFlagsUpdate).toHaveBeenCalledTimes(1);
    expect(mockFlagsUpdate).toHaveBeenCalledWith({ writing_session_habit_id: 31 }, 'settings-tok');
    expect(rowLabel(view)).toBe(writingTimerRowLabel('Morning pages'));
  });

  it('offers "Clear link" for a linked timer, which sends null and reads "not linked"', async () => {
    mockFlagsGet.mockResolvedValue(flags(31));
    const view = render(<JournalSection />);
    await waitFor(() => expect(rowLabel(view)).toBe(writingTimerRowLabel('Morning pages')));

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));
    fireEvent.press(view.getByTestId('writing-habit-clear'));

    await waitFor(() => expect(rowLabel(view)).toBe(WRITING_TIMER_ROW_UNLINKED));
    expect(mockFlagsUpdate).toHaveBeenCalledWith(
      { writing_session_habit_id: null },
      'settings-tok',
    );
  });

  it('a refused save keeps the old label and the picker open', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFlagsGet.mockResolvedValue(flags(31));
    mockFlagsUpdate.mockRejectedValue(new Error('403'));
    const view = render(<JournalSection />);
    await waitFor(() => expect(rowLabel(view)).toBe(writingTimerRowLabel('Morning pages')));

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));
    fireEvent.press(view.getByTestId('writing-habit-choose-32'));

    await waitFor(() => expect(mockFlagsUpdate).toHaveBeenCalled());
    await waitFor(() =>
      expect(view.getByTestId('writing-habit-choose-32').props.accessibilityState).toEqual({
        disabled: false,
      }),
    );
    expect(rowLabel(view)).toBe(writingTimerRowLabel('Morning pages'));
    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
  });

  it('Cancel closes the picker and changes nothing', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));
    fireEvent.press(view.getByTestId('writing-habit-cancel'));

    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
    expect(mockFlagsUpdate).not.toHaveBeenCalled();
  });

  it('tapping the row again closes the picker', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));
    fireEvent.press(view.getByTestId('settings-row-writing-habit'));

    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
  });

  it('reads the habits when the picker opens, so the list is current', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));
    mockLoadHabits.mockClear();

    fireEvent.press(view.getByTestId('settings-row-writing-habit'));

    expect(mockLoadHabits).toHaveBeenCalledWith('Europe/Lisbon');
  });
});

describe('JournalSection — offering again', () => {
  it('clears this device’s answer so the end-of-session offer comes back', async () => {
    const view = render(<JournalSection />);
    const row = view.getByTestId('settings-row-writing-offer-again');
    expect(row.props.accessibilityLabel).toBe(OFFER_AGAIN_LABEL);
    expect(row.props.accessibilityHint).toBe(OFFER_AGAIN_DESCRIPTION);

    fireEvent.press(row);

    expect(mockSaveAnswered).toHaveBeenCalledTimes(1);
    expect(mockSaveAnswered).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(view.getByTestId('settings-row-writing-offer-again').props.accessibilityHint).toBe(
        OFFER_AGAIN_DONE,
      ),
    );
  });

  it('both rows are buttons', () => {
    const view = render(<JournalSection />);

    expect(view.getByTestId('settings-row-writing-habit').props.accessibilityRole).toBe('button');
    expect(view.getByTestId('settings-row-writing-offer-again').props.accessibilityRole).toBe(
      'button',
    );
  });
});
