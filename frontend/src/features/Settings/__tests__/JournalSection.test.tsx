import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import JournalSection from '../JournalSection';

import type { UiFlags, UiFlagsUpdate } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import {
  MORNING_PAGES_OFFER_AGAIN_DESCRIPTION,
  MORNING_PAGES_OFFER_AGAIN_DONE,
  MORNING_PAGES_OFFER_AGAIN_LABEL,
  MORNING_PAGES_SETTINGS_COPY_ENTRIES,
} from '@/features/Journal/morningPagesCopy';
import {
  LINK_HABIT_NUDGE_AGAIN_DESCRIPTION,
  LINK_HABIT_NUDGE_AGAIN_DONE,
  LINK_HABIT_NUDGE_AGAIN_LABEL,
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
const mockRestoreTip = jest.fn<() => Promise<boolean>>();
const mockRestoreNudge = jest.fn<() => Promise<boolean>>();
/** The account's zone, which AuthContext can adopt from the server mid-mount. */
const mockUserTimezone = { current: 'Europe/Lisbon' };

jest.mock('@/api', () => ({
  uiFlags: {
    get: (token?: string) => mockFlagsGet(token),
    update: (partial: UiFlagsUpdate, token?: string) => mockFlagsUpdate(partial, token),
  },
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'settings-tok', userTimezone: mockUserTimezone.current }),
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: { loadHabits: (tz?: string) => mockLoadHabits(tz) },
}));

jest.mock('@/storage/writingOfferStorage', () => ({
  saveWritingOfferAnswered: (value: boolean) => mockSaveAnswered(value),
}));

jest.mock('@/storage/morningPagesTipStorage', () => ({
  restoreMorningPagesTip: () => mockRestoreTip(),
}));

jest.mock('@/storage/linkHabitNudgeStorage', () => ({
  restoreLinkHabitNudge: () => mockRestoreNudge(),
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
  mockRestoreTip.mockResolvedValue(true);
  mockRestoreNudge.mockResolvedValue(true);
  mockUserTimezone.current = 'Europe/Lisbon';
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

  it('every row is a button', () => {
    const view = render(<JournalSection />);

    expect(view.getByTestId('settings-row-writing-habit').props.accessibilityRole).toBe('button');
    expect(view.getByTestId('settings-row-writing-offer-again').props.accessibilityRole).toBe(
      'button',
    );
    expect(view.getByTestId('settings-row-morning-pages-offer-again').props.accessibilityRole).toBe(
      'button',
    );
  });
});

describe('JournalSection — offering morning pages again (#3005)', () => {
  const row = (view: ReturnType<typeof render>) =>
    view.getByTestId('settings-row-morning-pages-offer-again');

  it('clears this device’s "Don’t show this again", and says the tip is back', async () => {
    const view = render(<JournalSection />);
    expect(row(view).props.accessibilityLabel).toBe(MORNING_PAGES_OFFER_AGAIN_LABEL);
    expect(row(view).props.accessibilityHint).toBe(MORNING_PAGES_OFFER_AGAIN_DESCRIPTION);
    expect(view.getByText(MORNING_PAGES_OFFER_AGAIN_LABEL)).toBeTruthy();

    fireEvent.press(row(view));

    expect(mockRestoreTip).toHaveBeenCalledTimes(1);
    // Its own decline, not the end-of-session offer's.
    expect(mockSaveAnswered).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(row(view).props.accessibilityHint).toBe(MORNING_PAGES_OFFER_AGAIN_DONE),
    );
    expect(view.getByText(MORNING_PAGES_OFFER_AGAIN_DONE)).toBeTruthy();
    // The end-of-session row is untouched by it.
    expect(view.getByTestId('settings-row-writing-offer-again').props.accessibilityHint).toBe(
      OFFER_AGAIN_DESCRIPTION,
    );
  });

  it('keeps the offer when the restore could not be saved, rather than claiming it worked', async () => {
    mockRestoreTip.mockResolvedValueOnce(false);
    const view = render(<JournalSection />);

    fireEvent.press(row(view));

    await waitFor(() => expect(mockRestoreTip).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(row(view).props.accessibilityHint).toBe(MORNING_PAGES_OFFER_AGAIN_DESCRIPTION);
    expect(view.queryByText(MORNING_PAGES_OFFER_AGAIN_DONE)).toBeNull();
  });

  it('renders every Settings string its copy sweep lists, before and after the press', async () => {
    const view = render(<JournalSection />);
    const seen = new Set<string>();
    const collect = () => {
      seen.add(row(view).props.accessibilityLabel as string);
      seen.add(row(view).props.accessibilityHint as string);
    };
    collect();
    fireEvent.press(row(view));
    await waitFor(() =>
      expect(row(view).props.accessibilityHint).toBe(MORNING_PAGES_OFFER_AGAIN_DONE),
    );
    collect();
    for (const entry of MORNING_PAGES_SETTINGS_COPY_ENTRIES) {
      expect(seen).toContain(entry);
    }
  });
});

describe('JournalSection — opened on the writing-habit row (#3006)', () => {
  it('opens the picker at once when Settings is opened on the writing habit', async () => {
    const view = render(<JournalSection focus="writing-habit" />);

    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
    expect(mockLoadHabits).toHaveBeenCalledWith('Europe/Lisbon');
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));
  });

  it('starts closed without a focus, as before', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));

    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
    expect(mockLoadHabits).not.toHaveBeenCalled();
  });

  it('opens the picker when the focus arrives after the section has mounted', async () => {
    const view = render(<JournalSection />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));
    expect(view.queryByTestId('writing-habit-picker')).toBeNull();

    view.rerender(<JournalSection focus="writing-habit" />);

    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
  });

  it('never reopens a picker the writer closed when the time zone changes under it', async () => {
    const view = render(<JournalSection focus="writing-habit" />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));
    fireEvent.press(view.getByTestId('writing-habit-cancel'));
    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
    mockLoadHabits.mockClear();

    // e.g. TimezoneSettings pushed over the hub, or the server's zone adopted.
    mockUserTimezone.current = 'Asia/Tokyo';
    view.rerender(<JournalSection focus="writing-habit" />);

    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
    expect(mockLoadHabits).not.toHaveBeenCalled();
  });

  it('never reopens it on a later render with the same focus, or after a save', async () => {
    const view = render(<JournalSection focus="writing-habit" />);
    await waitFor(() => expect(useWritingHabitLinkStore.getState().hydrated).toBe(true));
    fireEvent.press(view.getByTestId('writing-habit-choose-31'));
    await waitFor(() =>
      expect(view.queryByTestId('writing-habit-picker')?.props.testID).toBeUndefined(),
    );

    view.rerender(<JournalSection focus="writing-habit" />);

    expect(view.queryByTestId('writing-habit-picker')).toBeNull();
  });
});

describe('JournalSection — showing the habit note again (#3006)', () => {
  const row = (view: ReturnType<typeof render>) =>
    view.getByTestId('settings-row-link-habit-nudge-again');

  it('is a fourth row, after the three that were there', () => {
    const view = render(<JournalSection />);
    const ids = view
      .getAllByRole('button')
      .map((button) => button.props.testID as string)
      .filter((id) => id.startsWith('settings-row-'));

    expect(ids).toEqual([
      'settings-row-writing-habit',
      'settings-row-writing-offer-again',
      'settings-row-morning-pages-offer-again',
      'settings-row-link-habit-nudge-again',
    ]);
  });

  it('clears this device’s "Don’t show again", and says the note is back', async () => {
    const view = render(<JournalSection />);
    expect(row(view).props.accessibilityLabel).toBe(LINK_HABIT_NUDGE_AGAIN_LABEL);
    expect(row(view).props.accessibilityHint).toBe(LINK_HABIT_NUDGE_AGAIN_DESCRIPTION);

    fireEvent.press(row(view));

    expect(mockRestoreNudge).toHaveBeenCalledTimes(1);
    expect(mockSaveAnswered).not.toHaveBeenCalled();
    expect(mockRestoreTip).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(row(view).props.accessibilityHint).toBe(LINK_HABIT_NUDGE_AGAIN_DONE),
    );
  });

  it('keeps its description when the restore could not be saved, rather than claiming it worked', async () => {
    mockRestoreNudge.mockResolvedValueOnce(false);
    const view = render(<JournalSection />);

    fireEvent.press(row(view));

    await waitFor(() => expect(mockRestoreNudge).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(row(view).props.accessibilityHint).toBe(LINK_HABIT_NUDGE_AGAIN_DESCRIPTION);
    expect(view.queryByText(LINK_HABIT_NUDGE_AGAIN_DONE)).toBeNull();
  });
});
