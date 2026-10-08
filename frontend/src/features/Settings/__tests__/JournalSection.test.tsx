import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import JournalSection from '../JournalSection';

import type { UiFlags, UiFlagsUpdate } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import {
  MORNING_PAGES_SETTINGS_COPY_ENTRIES,
  MORNING_PAGES_SWITCH_DESCRIPTION,
  MORNING_PAGES_SWITCH_LABEL,
} from '@/features/Journal/morningPagesCopy';
import {
  LINK_HABIT_NUDGE_SWITCH_DESCRIPTION,
  LINK_HABIT_NUDGE_SWITCH_LABEL,
  OFFER_SWITCH_DESCRIPTION,
  OFFER_SWITCH_LABEL,
  WRITING_TIMER_ROW_LINKED_PENDING,
  WRITING_TIMER_ROW_UNLINKED,
  writingTimerRowLabel,
} from '@/features/Journal/saveAsHabitCopy';
import { useHabitStore } from '@/store/useHabitStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const mockFlagsGet = jest.fn<(_token?: string) => Promise<UiFlags>>();
const mockFlagsUpdate = jest.fn<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>();
const mockLoadHabits = jest.fn<(_tz?: string) => Promise<void>>();
const mockLoadAnswered = jest.fn<() => Promise<boolean>>();
const mockSaveAnswered = jest.fn<(_value: boolean) => Promise<void>>();
const mockLoadTipState =
  jest.fn<() => Promise<{ setAsideOn: string | null; neverOffer: boolean }>>();
const mockRestoreTip = jest.fn<() => Promise<boolean>>();
const mockSaveTipNeverOffer = jest.fn<(_value: boolean) => Promise<boolean>>();
const mockLoadNudgeDeclined = jest.fn<() => Promise<boolean>>();
const mockRestoreNudge = jest.fn<() => Promise<boolean>>();
const mockSaveNudgeDeclined = jest.fn<() => Promise<boolean>>();
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
  loadWritingOfferAnswered: () => mockLoadAnswered(),
  saveWritingOfferAnswered: (value: boolean) => mockSaveAnswered(value),
}));

jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipState: () => mockLoadTipState(),
  restoreMorningPagesTip: () => mockRestoreTip(),
  saveMorningPagesTipNeverOffer: (value: boolean) => mockSaveTipNeverOffer(value),
}));

jest.mock('@/storage/linkHabitNudgeStorage', () => ({
  loadLinkHabitNudgeDeclined: () => mockLoadNudgeDeclined(),
  restoreLinkHabitNudge: () => mockRestoreNudge(),
  saveLinkHabitNudgeDeclined: () => mockSaveNudgeDeclined(),
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
  mockLoadAnswered.mockResolvedValue(false);
  mockSaveAnswered.mockResolvedValue(undefined);
  mockLoadTipState.mockResolvedValue({ setAsideOn: null, neverOffer: false });
  mockRestoreTip.mockResolvedValue(true);
  mockSaveTipNeverOffer.mockResolvedValue(true);
  mockLoadNudgeDeclined.mockResolvedValue(false);
  mockRestoreNudge.mockResolvedValue(true);
  mockSaveNudgeDeclined.mockResolvedValue(true);
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

// ---------------------------------------------------------------------------
// The three invitation switches: each the journal's own decline, seen from here.
// ---------------------------------------------------------------------------

type View = ReturnType<typeof render>;
const OFFER = 'settings-row-writing-offer';
const TIP = 'settings-row-morning-pages-offer';
const NUDGE = 'settings-row-link-habit-nudge';

const switchOf = (view: View, rowId: string) => view.getByTestId(`${rowId}-switch`);
const isOn = (view: View, rowId: string): boolean => switchOf(view, rowId).props.value as boolean;
const isDisabled = (view: View, rowId: string): boolean =>
  switchOf(view, rowId).props.accessibilityState.disabled as boolean;
const flip = (view: View, rowId: string, next: boolean): void => {
  fireEvent(switchOf(view, rowId), 'valueChange', next);
};
/** Waits for all three reads to answer, so a position shown is a confirmed one. */
const settled = async (view: View): Promise<void> => {
  await waitFor(() => expect(isDisabled(view, NUDGE)).toBe(false));
};

describe('JournalSection — the invitation switches', () => {
  it('follows the writing-habit row, as three switches rather than buttons', async () => {
    const view = render(<JournalSection />);
    await settled(view);

    const switches = view.getAllByRole('switch').map((node) => node.props.testID as string);
    expect(switches).toEqual([`${OFFER}-switch`, `${TIP}-switch`, `${NUDGE}-switch`]);
    expect(view.getByTestId('settings-row-writing-habit').props.accessibilityRole).toBe('button');
    expect(view.queryByTestId('settings-row-writing-offer-again')).toBeNull();
  });

  it('names each switch by its label and describes what it does, on this device', async () => {
    const view = render(<JournalSection />);
    await settled(view);

    expect(switchOf(view, OFFER).props.accessibilityLabel).toBe(OFFER_SWITCH_LABEL);
    expect(switchOf(view, OFFER).props.accessibilityHint).toBe(OFFER_SWITCH_DESCRIPTION);
    expect(switchOf(view, TIP).props.accessibilityLabel).toBe(MORNING_PAGES_SWITCH_LABEL);
    expect(switchOf(view, TIP).props.accessibilityHint).toBe(MORNING_PAGES_SWITCH_DESCRIPTION);
    expect(switchOf(view, NUDGE).props.accessibilityLabel).toBe(LINK_HABIT_NUDGE_SWITCH_LABEL);
    expect(switchOf(view, NUDGE).props.accessibilityHint).toBe(LINK_HABIT_NUDGE_SWITCH_DESCRIPTION);
    for (const entry of MORNING_PAGES_SETTINGS_COPY_ENTRIES) {
      expect(view.getByText(entry)).toBeTruthy();
    }
  });

  it('reads on, and is disabled until the read answers, when nothing was declined', async () => {
    let answer: (_declined: boolean) => void = () => undefined;
    mockLoadNudgeDeclined.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const view = render(<JournalSection />);

    expect(isDisabled(view, NUDGE)).toBe(true);
    await act(async () => {
      answer(false);
      await Promise.resolve();
    });

    await settled(view);
    expect(isOn(view, OFFER)).toBe(true);
    expect(isOn(view, TIP)).toBe(true);
    expect(isOn(view, NUDGE)).toBe(true);
  });

  it('turns itself off for whatever the journal recorded a decline on', async () => {
    mockLoadAnswered.mockResolvedValue(true);
    mockLoadTipState.mockResolvedValue({ setAsideOn: '2026-10-02', neverOffer: true });
    mockLoadNudgeDeclined.mockResolvedValue(true);
    const view = render(<JournalSection />);
    await settled(view);

    expect(isOn(view, OFFER)).toBe(false);
    expect(isOn(view, TIP)).toBe(false);
    expect(isOn(view, NUDGE)).toBe(false);
  });

  it('a set-aside-for-today alone leaves morning pages on: that is not a decline', async () => {
    mockLoadTipState.mockResolvedValue({ setAsideOn: '2026-10-02', neverOffer: false });
    const view = render(<JournalSection />);
    await settled(view);

    expect(isOn(view, TIP)).toBe(true);
  });

  it('turning the offer on clears this device’s answer; off records one', async () => {
    mockLoadAnswered.mockResolvedValue(true);
    const view = render(<JournalSection />);
    await settled(view);
    expect(isOn(view, OFFER)).toBe(false);

    flip(view, OFFER, true);
    await waitFor(() => expect(isOn(view, OFFER)).toBe(true));
    expect(mockSaveAnswered).toHaveBeenCalledWith(false);

    flip(view, OFFER, false);
    await waitFor(() => expect(isOn(view, OFFER)).toBe(false));
    expect(mockSaveAnswered).toHaveBeenLastCalledWith(true);
    // Its own flag, nobody else's.
    expect(mockRestoreTip).not.toHaveBeenCalled();
    expect(mockRestoreNudge).not.toHaveBeenCalled();
  });

  it('turning morning pages on restores the tip (today’s set-aside too); off declines it for good', async () => {
    mockLoadTipState.mockResolvedValue({ setAsideOn: null, neverOffer: true });
    const view = render(<JournalSection />);
    await settled(view);
    expect(isOn(view, TIP)).toBe(false);

    flip(view, TIP, true);
    await waitFor(() => expect(isOn(view, TIP)).toBe(true));
    expect(mockRestoreTip).toHaveBeenCalledTimes(1);
    expect(mockSaveTipNeverOffer).not.toHaveBeenCalled();

    flip(view, TIP, false);
    await waitFor(() => expect(isOn(view, TIP)).toBe(false));
    expect(mockSaveTipNeverOffer).toHaveBeenCalledWith(true);
    expect(mockRestoreTip).toHaveBeenCalledTimes(1);
    expect(mockSaveAnswered).not.toHaveBeenCalled();
  });

  it('turning the habit note on restores it; off records the decline', async () => {
    mockLoadNudgeDeclined.mockResolvedValue(true);
    const view = render(<JournalSection />);
    await settled(view);
    expect(isOn(view, NUDGE)).toBe(false);

    flip(view, NUDGE, true);
    await waitFor(() => expect(isOn(view, NUDGE)).toBe(true));
    expect(mockRestoreNudge).toHaveBeenCalledTimes(1);

    flip(view, NUDGE, false);
    await waitFor(() => expect(isOn(view, NUDGE)).toBe(false));
    expect(mockSaveNudgeDeclined).toHaveBeenCalledTimes(1);
    expect(mockSaveAnswered).not.toHaveBeenCalled();
    expect(mockRestoreTip).not.toHaveBeenCalled();
  });

  it('keeps the old position when a write could not be saved, rather than claiming it moved', async () => {
    mockLoadTipState.mockResolvedValue({ setAsideOn: null, neverOffer: true });
    mockRestoreTip.mockResolvedValueOnce(false);
    mockLoadNudgeDeclined.mockResolvedValue(true);
    mockRestoreNudge.mockResolvedValueOnce(false);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSaveAnswered.mockRejectedValueOnce(new Error('quota'));
    const view = render(<JournalSection />);
    await settled(view);

    flip(view, TIP, true);
    flip(view, NUDGE, true);
    flip(view, OFFER, false);

    await waitFor(() => expect(mockRestoreTip).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockRestoreNudge).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockSaveAnswered).toHaveBeenCalledTimes(1));
    await settled(view);
    expect(isOn(view, TIP)).toBe(false);
    expect(isOn(view, NUDGE)).toBe(false);
    expect(isOn(view, OFFER)).toBe(true);
  });

  it('disables a switch while its write is out, so a second tap cannot race the first', async () => {
    let land: (_saved: boolean) => void = () => undefined;
    mockRestoreNudge.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));
    mockLoadNudgeDeclined.mockResolvedValue(true);
    const view = render(<JournalSection />);
    await settled(view);

    flip(view, NUDGE, true);
    expect(isDisabled(view, NUDGE)).toBe(true);
    expect(isDisabled(view, OFFER)).toBe(false);

    await act(async () => {
      land(true);
      await Promise.resolve();
    });
    await settled(view);
    expect(isOn(view, NUDGE)).toBe(true);
  });
});
