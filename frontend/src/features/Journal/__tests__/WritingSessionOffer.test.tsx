/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { keepAsPractice } from '../keepAsPractice';
import {
  linkedHabitConfirmation,
  savedAndLinkedConfirmation,
  savedHabitConfirmation,
} from '../saveAsHabitCopy';
import WritingSessionOffer from '../WritingSessionOffer';

import type { UiFlags, UiFlagsUpdate } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const mockUserTimezone = 'America/Los_Angeles';

const keepPractice = keepAsPractice as jest.Mock;

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: mockUserTimezone, token: 'offer-tok' }),
}));

const mockFlagsUpdate = jest.fn<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>();

jest.mock('@/api', () => ({
  uiFlags: {
    get: jest.fn(() => Promise.reject(new Error('not configured'))),
    update: (partial: UiFlagsUpdate, token?: string) => mockFlagsUpdate(partial, token),
  },
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    insertHabitAtWithId: jest.fn(() => Promise.resolve({ kept: true, habitId: null })),
    loadHabits: jest.fn(() => Promise.resolve(undefined)),
  },
}));

jest.mock('@/storage/writingOfferStorage', () => ({
  loadWritingOfferAnswered: jest.fn(() => Promise.resolve(false)),
  saveWritingOfferAnswered: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('../keepAsPractice', () => ({
  planKeepAsPractice: jest.fn(() =>
    Promise.resolve({
      practiceId: 41,
      displaces: null,
      waitingAt: null,
    }),
  ),
  keepAsPractice: jest.fn(() => Promise.resolve({ kept: true, sessionLogged: true })),
}));

// The offer keeps a new habit through ``insertHabitAtWithId`` so it can link the
// row it kept (#2861); the tests keep the shorter name.
const insertHabitAt = habitManager.insertHabitAtWithId as jest.Mock;
const KEPT = { kept: true, habitId: null };
const NOT_KEPT = { kept: false, habitId: null };
const loadAnswered = loadWritingOfferAnswered as jest.Mock;
const saveAnswered = saveWritingOfferAnswered as jest.Mock;

function habit(id: number, name: string, stage: string, extra: Partial<Habit> = {}): Habit {
  return {
    id,
    stage,
    name,
    icon: '✨',
    streak: 0,
    energy_cost: 5,
    energy_return: 5,
    start_date: new Date('2026-01-01T00:00:00Z'),
    goals: [],
    ...extra,
  };
}

const THREE_HABITS = [
  habit(1, 'Meditate', 'Beige'),
  habit(2, 'Walk', 'Purple'),
  habit(3, 'Read', 'Red'),
];

beforeEach(() => {
  jest.clearAllMocks();
  loadAnswered.mockImplementation(() => Promise.resolve(false));
  insertHabitAt.mockImplementation(() => Promise.resolve(KEPT));
  useHabitStore.setState({ habits: THREE_HABITS, loading: false, error: null });
  useWritingHabitLinkStore.getState().reset();
  mockFlagsUpdate.mockImplementation((partial) =>
    Promise.resolve({
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
      writing_session_habit_id: partial.writing_session_habit_id ?? null,
      practice_session_habit_id: null,
    }),
  );
});

/** The finished session every render here is about: twenty minutes, run out. */
const RESULT = {
  plannedMinutes: 20,
  elapsedMs: 20 * 60 * 1000,
  elapsedMinutes: 20,
  reachedFullDuration: true,
};

/** Render and wait for the asynchronous decline read to settle. */
async function renderOffer() {
  const view = render(<WritingSessionOffer result={RESULT} />);
  await waitFor(() => expect(view.queryByTestId('save-as-habit-accept')).not.toBeNull());
  return view;
}

/**
 * Take the habit branch up and choose a NEW habit, which is what the placement
 * step is for. Since #2861 "Keep this as a habit" first asks which habit — an
 * existing one or a new Journaling one — so the placement flows below go
 * through that choice exactly as a writer would.
 */
async function openPlacing(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.press(view.getByTestId('save-as-habit-accept'));
  fireEvent.press(view.getByTestId('writing-habit-new'));
  await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());
}

/** The name/stage pairs the prioritise preview is showing. */
function previewRows(view: ReturnType<typeof render>): string[] {
  return view.getAllByTestId(/^save-as-habit-row-\d+$/).map((row) => {
    const [label] = row.props.children as [{ props: { children: string } }];
    return label.props.children;
  });
}

describe('WritingSessionOffer — the invitation', () => {
  it('offers the session as a habit, with a decline beside it', async () => {
    const view = await renderOffer();

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(view.getByTestId('save-as-habit-decline')).toBeTruthy();
  });

  it('never appears again once it has been answered', async () => {
    loadAnswered.mockImplementation(() => Promise.resolve(true));

    const view = render(<WritingSessionOffer result={RESULT} />);

    await waitFor(() => expect(loadAnswered).toHaveBeenCalled());
    expect(view.queryByTestId('save-as-habit-accept')).toBeNull();
    expect(view.queryByTestId('save-as-habit-decline')).toBeNull();
  });

  it('takes one tap to decline, and records it so the next session does not ask', async () => {
    const view = await renderOffer();

    fireEvent.press(view.getByTestId('save-as-habit-decline'));

    expect(saveAnswered).toHaveBeenCalledWith(true);
    await waitFor(() => expect(view.queryByTestId('save-as-habit-accept')).toBeNull());
    expect(insertHabitAt).not.toHaveBeenCalled();
  });
});

describe('WritingSessionOffer — choosing where it sits', () => {
  it('opens the prioritise step with Journaling first and everything else one stage later', async () => {
    const view = await renderOffer();

    await openPlacing(view);
    expect(previewRows(view)).toEqual([
      'Journaling — Beige',
      'Meditate — Purple',
      'Walk — Red',
      'Read — Blue',
    ]);
  });

  it('moves it one place later and re-previews the stage every habit then lands on', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-move-later'));

    expect(previewRows(view)).toEqual([
      'Meditate — Beige',
      'Journaling — Purple',
      'Walk — Red',
      'Read — Blue',
    ]);
  });

  it('moves it back earlier again', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-move-later'));
    fireEvent.press(view.getByTestId('save-as-habit-move-later'));
    fireEvent.press(view.getByTestId('save-as-habit-move-earlier'));

    expect(previewRows(view)[1]).toBe('Journaling — Purple');
  });

  it('will not move it above the top or below the bottom', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-move-earlier'));
    expect(previewRows(view)[0]).toBe('Journaling — Beige');

    for (let i = 0; i < 6; i += 1) fireEvent.press(view.getByTestId('save-as-habit-move-later'));
    expect(previewRows(view)).toEqual([
      'Meditate — Beige',
      'Walk — Purple',
      'Read — Red',
      'Journaling — Blue',
    ]);

    // The bound has to hold in the STATE, not only in what is drawn from it:
    // presses that ran off the end and were merely clamped on the way to the
    // screen would leave the chosen position three past the bottom, and the
    // next Move up would be a button that visibly does nothing three times
    // running.
    fireEvent.press(view.getByTestId('save-as-habit-move-earlier'));
    expect(previewRows(view)[2]).toBe('Journaling — Red');
  });

  it('previews a carryover habit on its own mirrored lap, not on the program ladder', async () => {
    useHabitStore.setState({
      habits: [habit(9, 'Carried', 'Beige', { is_carryover: true }), habit(1, 'Meditate', 'Beige')],
      loading: false,
      error: null,
    });
    const view = await renderOffer();

    await openPlacing(view);
    expect(previewRows(view)).toEqual([
      'Journaling — Beige',
      'Carried — Clear Light',
      'Meditate — Purple',
    ]);
  });

  it('backing out of the prioritise step leaves the offer standing and records no decline', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-cancel'));

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(saveAnswered).not.toHaveBeenCalled();
  });
});

describe('WritingSessionOffer — confirming', () => {
  it('inserts the habit at the position the writer chose', async () => {
    const view = await renderOffer();
    await openPlacing(view);
    fireEvent.press(view.getByTestId('save-as-habit-move-later'));

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(insertHabitAt).toHaveBeenCalledWith(
      { name: 'Journaling', icon: '📓' },
      1,
      mockUserTimezone,
    );
  });

  it('is not offered again on a later session once the habit has been kept', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(saveAnswered).toHaveBeenCalledWith(true));
  });

  it('leaves the offer open when the write rolled back, so nothing is silently spent', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve(NOT_KEPT));
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(saveAnswered).not.toHaveBeenCalled();
  });

  it('says where the habit went once it is saved, and stops offering', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
    expect(view.queryByTestId('save-as-habit-accept')).toBeNull();
    expect(view.queryByTestId('save-as-habit-confirm')).toBeNull();
  });

  it('does not claim a habit that the write rolled back', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve(NOT_KEPT));
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(view.queryByTestId('save-as-habit-saved')).toBeNull();
    expect(view.getByTestId('save-as-habit-confirm')).toBeTruthy();
  });

  it('will not write twice while the first write is still in flight', async () => {
    let settle: ((value: typeof KEPT) => void) | undefined;
    insertHabitAt.mockImplementation(
      () =>
        new Promise<typeof KEPT>((resolve) => {
          settle = resolve;
        }),
    );
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));
    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    expect(insertHabitAt).toHaveBeenCalledTimes(1);
    settle?.(KEPT);
    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
  });

  it('reads the writer’s habits when the offer is taken up, not before', async () => {
    const view = await renderOffer();

    expect(habitManager.loadHabits).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    expect(habitManager.loadHabits).toHaveBeenCalledTimes(1);
    expect(habitManager.loadHabits).toHaveBeenCalledWith(mockUserTimezone);
  });
});

describe('WritingSessionOffer — the practice beside the habit', () => {
  it('offers both ways to keep it, under a single decline', async () => {
    const view = await renderOffer();

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(view.getByTestId('save-as-practice-accept')).toBeTruthy();
    expect(view.getAllByTestId('save-as-habit-decline')).toHaveLength(1);
  });

  it('opens the practice step without reading the writer’s habits', async () => {
    const view = await renderOffer();

    fireEvent.press(view.getByTestId('save-as-practice-accept'));

    await waitFor(() => expect(view.queryByTestId('save-as-practice-summary')).not.toBeNull());
    expect(habitManager.loadHabits).not.toHaveBeenCalled();
    expect(view.queryByTestId('save-as-habit-preview')).toBeNull();
  });

  it('comes back to both offers when the practice step is stepped out of', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-practice-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-practice-cancel')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-practice-cancel'));

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(view.getByTestId('save-as-practice-accept')).toBeTruthy();
    expect(saveAnswered).not.toHaveBeenCalled();
  });

  it('is not offered again on a later session once the practice has been kept', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-practice-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-practice-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(saveAnswered).toHaveBeenCalledWith(true));
    expect(view.queryByTestId('save-as-habit-accept')).toBeNull();
  });

  it('hands the practice step the session that has just finished', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-practice-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-practice-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(keepPractice).toHaveBeenCalled());
    const [, writing] = keepPractice.mock.calls[0] as [unknown, { elapsedMs: number }];
    expect(writing.elapsedMs).toBe(RESULT.elapsedMs);
  });

  it('records when the session ended, not when the writer got round to answering', async () => {
    // A clock that has moved on by the time anything is tapped. The offer must
    // still report the instant it appeared, which is when the writing stopped.
    const NOTE_APPEARED = new Date('2026-09-08T09:20:00.000Z');
    const LATER = new Date('2026-09-08T09:32:00.000Z');
    let reads = 0;
    const clock = (): Date => {
      reads += 1;
      return reads === 1 ? NOTE_APPEARED : LATER;
    };
    const view = render(<WritingSessionOffer result={RESULT} now={clock} />);
    await waitFor(() => expect(view.queryByTestId('save-as-practice-accept')).not.toBeNull());
    fireEvent.press(view.getByTestId('save-as-practice-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-practice-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(keepPractice).toHaveBeenCalled());
    const [, writing] = keepPractice.mock.calls[0] as [unknown, { endedAt: Date }];
    expect(writing.endedAt.toISOString()).toBe(NOTE_APPEARED.toISOString());
  });

  it('does not survive a decline, either way it could have been taken', async () => {
    loadAnswered.mockImplementation(() => Promise.resolve(true));

    const view = render(<WritingSessionOffer result={RESULT} />);

    await waitFor(() => expect(loadAnswered).toHaveBeenCalled());
    expect(view.queryByTestId('save-as-practice-accept')).toBeNull();
  });
});

const ladderGoals = (): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
    id: 100 + index,
    title: tier,
    tier,
    target: index + 1,
    target_unit: 'pages',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  }));

const LINKABLE = [
  habit(21, 'Morning pages', 'Beige', { goals: ladderGoals(), revealed: true }),
  habit(22, 'Stretch', 'Purple', { goals: ladderGoals(), revealed: true }),
];

describe('WritingSessionOffer — keeping it as a habit the writer already has (#2861)', () => {
  beforeEach(() => {
    useHabitStore.setState({ habits: LINKABLE, loading: false, error: null });
  });

  it('asks which habit first: the writer’s own, by name, then a new Journaling habit', async () => {
    const view = await renderOffer();

    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
    expect(view.getByText('Morning pages')).toBeTruthy();
    expect(view.getByText('Stretch')).toBeTruthy();
    expect(view.getByTestId('writing-habit-new')).toBeTruthy();
    expect(view.queryByTestId('save-as-habit-confirm')).toBeNull();
  });

  it('choosing one links it exactly once, settles the offer, and says what will happen', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    fireEvent.press(view.getByTestId('writing-habit-choose-22'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-linked')).not.toBeNull());
    expect(mockFlagsUpdate).toHaveBeenCalledTimes(1);
    expect(mockFlagsUpdate).toHaveBeenCalledWith({ writing_session_habit_id: 22 }, 'offer-tok');
    expect(saveAnswered).toHaveBeenCalledWith(true);
    expect(view.getByText(linkedHabitConfirmation('Stretch'))).toBeTruthy();
    expect(insertHabitAt).not.toHaveBeenCalled();
    expect(useWritingHabitLinkStore.getState().habitId).toBe(22);
  });

  it('a second tap while the link is saving is not spent', async () => {
    let finish: ((flags: UiFlags) => void) | undefined;
    mockFlagsUpdate.mockImplementation(
      () =>
        new Promise<UiFlags>((resolve) => {
          finish = resolve;
        }),
    );
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    fireEvent.press(view.getByTestId('writing-habit-choose-21'));
    fireEvent.press(view.getByTestId('writing-habit-choose-21'));

    expect(mockFlagsUpdate).toHaveBeenCalledTimes(1);
    finish?.({
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
      writing_session_habit_id: 21,
      practice_session_habit_id: null,
    });
    await waitFor(() => expect(view.queryByTestId('save-as-habit-linked')).not.toBeNull());
  });

  it('a refused link leaves the picker open and the offer unanswered', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFlagsUpdate.mockImplementation(() => Promise.reject(new Error('403')));
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    fireEvent.press(view.getByTestId('writing-habit-choose-21'));

    await waitFor(() => expect(mockFlagsUpdate).toHaveBeenCalled());
    await waitFor(() =>
      expect(view.getByTestId('writing-habit-choose-21').props.accessibilityState).toEqual({
        disabled: false,
      }),
    );
    expect(view.getByTestId('writing-habit-picker')).toBeTruthy();
    expect(view.queryByTestId('save-as-habit-linked')).toBeNull();
    expect(saveAnswered).not.toHaveBeenCalled();
  });

  it('Cancel goes back to the invitation and answers nothing', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    fireEvent.press(view.getByTestId('writing-habit-cancel'));

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(view.getByTestId('save-as-habit-decline')).toBeTruthy();
    expect(saveAnswered).not.toHaveBeenCalled();
    expect(mockFlagsUpdate).not.toHaveBeenCalled();
  });

  it('"No thanks" is still one tap, beside the accept', async () => {
    const view = await renderOffer();

    fireEvent.press(view.getByTestId('save-as-habit-decline'));

    expect(saveAnswered).toHaveBeenCalledWith(true);
    await waitFor(() => expect(view.queryByTestId('save-as-habit-offer')).toBeNull());
  });
});

describe('WritingSessionOffer — a link the server already holds (#2861)', () => {
  it('does not offer again when the account already has a linked habit, even on a new device', async () => {
    useWritingHabitLinkStore.setState({ habitId: 21, hydrated: true });

    const view = render(<WritingSessionOffer result={RESULT} />);

    await waitFor(() => expect(loadAnswered).toHaveBeenCalled());
    expect(view.queryByTestId('save-as-habit-offer')).toBeNull();
    expect(view.queryByTestId('save-as-habit-accept')).toBeNull();
  });

  it('an unread link never withholds the offer', async () => {
    useWritingHabitLinkStore.setState({ habitId: 21, hydrated: false });

    const view = await renderOffer();

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
  });

  it('a server that says "no link" leaves the offer standing', async () => {
    useWritingHabitLinkStore.setState({ habitId: null, hydrated: true });

    const view = await renderOffer();

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
  });
});

describe('WritingSessionOffer — a new Journaling habit is linked too (#2861)', () => {
  const NEW_HABIT_ID = 88;

  it('links the habit it just kept, and says it is checked off once it is open', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve({ kept: true, habitId: NEW_HABIT_ID }));
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
    await waitFor(() => expect(view.getByText(savedAndLinkedConfirmation())).toBeTruthy());
    expect(mockFlagsUpdate).toHaveBeenCalledTimes(1);
    expect(mockFlagsUpdate).toHaveBeenCalledWith(
      { writing_session_habit_id: NEW_HABIT_ID },
      'offer-tok',
    );
    expect(useWritingHabitLinkStore.getState().habitId).toBe(NEW_HABIT_ID);
  });

  it('a kept habit whose link was refused is still kept, and claims no link', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    insertHabitAt.mockImplementation(() => Promise.resolve({ kept: true, habitId: NEW_HABIT_ID }));
    mockFlagsUpdate.mockImplementation(() => Promise.reject(new Error('403')));
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(mockFlagsUpdate).toHaveBeenCalled());
    await waitFor(() => expect(view.getByText(savedHabitConfirmation())).toBeTruthy());
    expect(view.queryByText(savedAndLinkedConfirmation())).toBeNull();
    expect(saveAnswered).toHaveBeenCalledWith(true);
  });

  it('links nothing when the insert named no habit to link', async () => {
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
    expect(mockFlagsUpdate).not.toHaveBeenCalled();
  });

  it('links nothing when the habit was not kept', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve(NOT_KEPT));
    const view = await renderOffer();
    await openPlacing(view);

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(mockFlagsUpdate).not.toHaveBeenCalled();
  });
});
