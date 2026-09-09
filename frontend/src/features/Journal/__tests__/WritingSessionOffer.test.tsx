/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { keepAsPractice } from '../keepAsPractice';
import WritingSessionOffer from '../WritingSessionOffer';

import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';

const keepPractice = keepAsPractice as jest.Mock;

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    insertHabitAt: jest.fn(() => Promise.resolve(true)),
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

const insertHabitAt = habitManager.insertHabitAt as jest.Mock;
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
  loadAnswered.mockImplementation(() => Promise.resolve(false));
  insertHabitAt.mockImplementation(() => Promise.resolve(true));
  useHabitStore.setState({ habits: THREE_HABITS, loading: false, error: null });
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

    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());
    expect(previewRows(view)).toEqual([
      'Journaling — Beige',
      'Meditate — Purple',
      'Walk — Red',
      'Read — Blue',
    ]);
  });

  it('moves it one place later and re-previews the stage every habit then lands on', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

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
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-move-later'));
    fireEvent.press(view.getByTestId('save-as-habit-move-later'));
    fireEvent.press(view.getByTestId('save-as-habit-move-earlier'));

    expect(previewRows(view)[1]).toBe('Journaling — Purple');
  });

  it('will not move it above the top or below the bottom', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

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

    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());
    expect(previewRows(view)).toEqual([
      'Journaling — Beige',
      'Carried — Clear Light',
      'Meditate — Purple',
    ]);
  });

  it('backing out of the prioritise step leaves the offer standing and records no decline', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-cancel'));

    expect(view.getByTestId('save-as-habit-accept')).toBeTruthy();
    expect(saveAnswered).not.toHaveBeenCalled();
  });
});

describe('WritingSessionOffer — confirming', () => {
  it('inserts the habit at the position the writer chose', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());
    fireEvent.press(view.getByTestId('save-as-habit-move-later'));

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(insertHabitAt).toHaveBeenCalledWith({ name: 'Journaling', icon: '📓' }, 1);
  });

  it('is not offered again on a later session once the habit has been kept', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(saveAnswered).toHaveBeenCalledWith(true));
  });

  it('leaves the offer open when the write rolled back, so nothing is silently spent', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve(false));
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(saveAnswered).not.toHaveBeenCalled();
  });

  it('says where the habit went once it is saved, and stops offering', async () => {
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
    expect(view.queryByTestId('save-as-habit-accept')).toBeNull();
    expect(view.queryByTestId('save-as-habit-confirm')).toBeNull();
  });

  it('does not claim a habit that the write rolled back', async () => {
    insertHabitAt.mockImplementation(() => Promise.resolve(false));
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    await waitFor(() => expect(insertHabitAt).toHaveBeenCalled());
    expect(view.queryByTestId('save-as-habit-saved')).toBeNull();
    expect(view.getByTestId('save-as-habit-confirm')).toBeTruthy();
  });

  it('will not write twice while the first write is still in flight', async () => {
    let settle: ((value: boolean) => void) | undefined;
    insertHabitAt.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const view = await renderOffer();
    fireEvent.press(view.getByTestId('save-as-habit-accept'));
    await waitFor(() => expect(view.queryByTestId('save-as-habit-confirm')).not.toBeNull());

    fireEvent.press(view.getByTestId('save-as-habit-confirm'));
    fireEvent.press(view.getByTestId('save-as-habit-confirm'));

    expect(insertHabitAt).toHaveBeenCalledTimes(1);
    settle?.(true);
    await waitFor(() => expect(view.queryByTestId('save-as-habit-saved')).not.toBeNull());
  });

  it('reads the writer’s habits when the offer is taken up, not before', async () => {
    const view = await renderOffer();

    expect(habitManager.loadHabits).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId('save-as-habit-accept'));

    expect(habitManager.loadHabits).toHaveBeenCalledTimes(1);
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
