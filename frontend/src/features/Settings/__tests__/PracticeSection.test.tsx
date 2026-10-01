import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import PracticeSection from '../PracticeSection';

import type { UiFlags, UiFlagsUpdate } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import {
  PRACTICE_HABIT_ROW_DESCRIPTION,
  PRACTICE_HABIT_ROW_LINKED_PENDING,
  PRACTICE_HABIT_ROW_UNLINKED,
  practiceHabitRowLabel,
} from '@/features/Practice/practiceHabitCopy';
import { useHabitStore } from '@/store/useHabitStore';
import { usePracticeHabitLinkStore } from '@/store/usePracticeHabitLinkStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const mockFlagsGet = jest.fn<(_token?: string) => Promise<UiFlags>>();
const mockFlagsUpdate = jest.fn<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>();
const mockLoadHabits = jest.fn<(_tz?: string) => Promise<void>>();

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

const WRITING_HABIT_ID = 31;

const ladder = (): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
    id: 200 + index,
    title: tier,
    tier,
    target: index + 1,
    target_unit: 'minutes',
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

const HABITS = [habit(WRITING_HABIT_ID, 'Morning pages'), habit(32, 'Sit')];

const flags = (habitId: number | null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: WRITING_HABIT_ID,
  practice_session_habit_id: habitId,
});

const rowLabel = (view: ReturnType<typeof render>): string =>
  view.getByTestId('settings-row-practice-habit').props.accessibilityLabel as string;

beforeEach(() => {
  jest.clearAllMocks();
  usePracticeHabitLinkStore.getState().reset();
  useWritingHabitLinkStore.getState().reset();
  useHabitStore.getState().setHabits(HABITS);
  mockFlagsGet.mockResolvedValue(flags(null));
  mockFlagsUpdate.mockImplementation((partial) =>
    Promise.resolve(flags(partial.practice_session_habit_id ?? null)),
  );
  mockLoadHabits.mockResolvedValue(undefined);
});

describe('PracticeSection — the practice sessions row', () => {
  it('is its own "Practice" group, and reads the link from the server on mount', async () => {
    const view = render(<PracticeSection />);

    expect(view.getByTestId('settings-group-practice')).toBeTruthy();
    expect(view.getByText('Practice')).toBeTruthy();
    await waitFor(() => expect(mockFlagsGet).toHaveBeenCalledWith('settings-tok'));
    expect(view.getByTestId('settings-row-practice-habit').props.accessibilityHint).toBe(
      PRACTICE_HABIT_ROW_DESCRIPTION,
    );
  });

  it('says "not linked" when the server holds no practice link, whatever the writing link', async () => {
    const view = render(<PracticeSection />);
    await waitFor(() => expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true));

    expect(rowLabel(view)).toBe(PRACTICE_HABIT_ROW_UNLINKED);
    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
  });

  it('names the linked habit by its own name', async () => {
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<PracticeSection />);

    await waitFor(() => expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit')));
    expect(view.getByText('Practice sessions → Sit')).toBeTruthy();
  });

  it('says a linked habit that is locked is paused', async () => {
    useHabitStore.getState().setHabits([{ ...habit(32, 'Sit'), revealed: false }]);
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<PracticeSection />);

    await waitFor(() =>
      expect(rowLabel(view)).toBe('Practice sessions → Sit · paused while locked'),
    );
  });

  it('never says "not linked" for a link whose habit has not been read yet, and reads it', async () => {
    useHabitStore.getState().setHabits([]);
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<PracticeSection />);

    await waitFor(() => expect(rowLabel(view)).toBe(PRACTICE_HABIT_ROW_LINKED_PENDING));
    await waitFor(() => expect(mockLoadHabits).toHaveBeenCalledWith('Europe/Lisbon'));

    act(() => useHabitStore.getState().setHabits(HABITS));
    expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit'));
  });

  it('opens the practice picker, and choosing a habit links it and closes the picker', async () => {
    const view = render(<PracticeSection />);
    await waitFor(() => expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true));

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    expect(view.getByTestId('practice-habit-picker')).toBeTruthy();
    expect(view.queryByTestId('practice-habit-new')).toBeNull();
    expect(view.queryByTestId('practice-habit-clear')).toBeNull();

    fireEvent.press(view.getByTestId('practice-habit-choose-32'));

    await waitFor(() =>
      expect(view.queryByTestId('practice-habit-picker')?.props.testID).toBeUndefined(),
    );
    expect(mockFlagsUpdate).toHaveBeenCalledTimes(1);
    expect(mockFlagsUpdate).toHaveBeenCalledWith({ practice_session_habit_id: 32 }, 'settings-tok');
    expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit'));
  });

  it('offers "Clear link" for a linked practice, which sends null and reads "not linked"', async () => {
    mockFlagsGet.mockResolvedValue(flags(32));
    const view = render(<PracticeSection />);
    await waitFor(() => expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit')));

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    fireEvent.press(view.getByTestId('practice-habit-clear'));

    await waitFor(() => expect(rowLabel(view)).toBe(PRACTICE_HABIT_ROW_UNLINKED));
    expect(mockFlagsUpdate).toHaveBeenCalledWith(
      { practice_session_habit_id: null },
      'settings-tok',
    );
  });

  it('a refused save keeps the old label and the picker open', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFlagsGet.mockResolvedValue(flags(32));
    mockFlagsUpdate.mockRejectedValue(new Error('403'));
    const view = render(<PracticeSection />);
    await waitFor(() => expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit')));

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    fireEvent.press(view.getByTestId('practice-habit-choose-31'));

    await waitFor(() => expect(mockFlagsUpdate).toHaveBeenCalled());
    await waitFor(() =>
      expect(view.getByTestId('practice-habit-choose-31').props.accessibilityState).toEqual({
        disabled: false,
      }),
    );
    expect(rowLabel(view)).toBe(practiceHabitRowLabel('Sit'));
    expect(view.getByTestId('practice-habit-picker')).toBeTruthy();
  });

  it('Cancel closes the picker and changes nothing; tapping the row again closes it too', async () => {
    const view = render(<PracticeSection />);
    await waitFor(() => expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true));

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    fireEvent.press(view.getByTestId('practice-habit-cancel'));
    expect(view.queryByTestId('practice-habit-picker')).toBeNull();

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    fireEvent.press(view.getByTestId('settings-row-practice-habit'));
    expect(view.queryByTestId('practice-habit-picker')).toBeNull();
    expect(mockFlagsUpdate).not.toHaveBeenCalled();
  });

  it('reads the habits when the picker opens, so the list is current', async () => {
    const view = render(<PracticeSection />);
    await waitFor(() => expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true));
    mockLoadHabits.mockClear();

    fireEvent.press(view.getByTestId('settings-row-practice-habit'));

    expect(mockLoadHabits).toHaveBeenCalledWith('Europe/Lisbon');
  });

  it('the row is a button', () => {
    const view = render(<PracticeSection />);

    expect(view.getByTestId('settings-row-practice-habit').props.accessibilityRole).toBe('button');
  });
});
