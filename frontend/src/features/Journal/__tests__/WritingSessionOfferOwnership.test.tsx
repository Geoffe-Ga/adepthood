/**
 * Account-epoch guards on the end-of-session offer's answered gate (#3329): the
 * mount-time "already answered?" read and the settle write never land under an
 * account other than the one they started under, across A to B to A as well.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import WritingSessionOffer from '../WritingSessionOffer';

import { setActiveUser } from '@/storage/userScope';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: 'America/Los_Angeles', token: 'offer-tok' }),
}));

jest.mock('@/api', () => ({
  uiFlags: {
    get: jest.fn(() => Promise.reject(new Error('not configured'))),
    update: jest.fn(() => Promise.reject(new Error('not configured'))),
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
    Promise.resolve({ practiceId: 41, displaces: null, waitingAt: null }),
  ),
  keepAsPractice: jest.fn(() => Promise.resolve({ kept: true, sessionLogged: true })),
}));

const loadAnswered = loadWritingOfferAnswered as jest.Mock;
const saveAnswered = saveWritingOfferAnswered as jest.Mock;
const OFFER = 'save-as-habit-accept';
const DECLINE = 'save-as-habit-decline';

const RESULT = {
  plannedMinutes: 20,
  elapsedMs: 20 * 60 * 1000,
  elapsedMinutes: 20,
  reachedFullDuration: true,
};

/** An answered-flag read the test settles by hand. */
function heldAnswered(): (_answered: boolean) => void {
  let settle: (_answered: boolean) => void = () => undefined;
  loadAnswered.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
  );
  return (answered) => settle(answered);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  loadAnswered.mockImplementation(() => Promise.resolve(false));
  useHabitStore.setState({ habits: [], loading: false, error: null });
  useWritingHabitLinkStore.getState().reset();
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

it('makes the offer for the same account once its read lands', async () => {
  const settle = heldAnswered();
  const view = render(<WritingSessionOffer result={RESULT} />);
  expect(view.queryByTestId(OFFER)).toBeNull();
  await act(async () => {
    settle(false);
  });
  expect(await view.findByTestId(OFFER)).toBeTruthy();
});

it('withdraws A’s offer at render time when B arrives, before B’s read lands', async () => {
  const view = render(<WritingSessionOffer result={RESULT} />);
  await flush();
  expect(view.getByTestId(OFFER)).toBeTruthy();
  heldAnswered();
  act(() => setActiveUser(2));
  expect(view.queryByTestId(OFFER)).toBeNull();
});

it('ignores A’s late read after A to B', async () => {
  const settleA = heldAnswered();
  loadAnswered.mockImplementationOnce(() => Promise.resolve(true));
  const view = render(<WritingSessionOffer result={RESULT} />);
  act(() => setActiveUser(2));
  await flush();
  await act(async () => {
    settleA(false);
    await Promise.resolve();
  });
  expect(view.queryByTestId(OFFER)).toBeNull();
});

it('ignores A’s late read after A to B to A, keeping the fresh A answer', async () => {
  const settleA = heldAnswered();
  loadAnswered.mockImplementationOnce(() => Promise.resolve(true));
  const view = render(<WritingSessionOffer result={RESULT} />);
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await flush();
  expect(loadAnswered).toHaveBeenCalledTimes(2);
  await act(async () => {
    settleA(false);
    await Promise.resolve();
  });
  expect(view.queryByTestId(OFFER)).toBeNull();
});

it('settles the offer for the same account when the writer declines it', async () => {
  const view = render(<WritingSessionOffer result={RESULT} />);
  await flush();
  fireEvent.press(view.getByTestId(DECLINE));
  expect(saveAnswered).toHaveBeenCalledWith(true);
});

it('refuses a decline pressed from a stale render after the account changed', async () => {
  const view = render(<WritingSessionOffer result={RESULT} />);
  await flush();
  const staleDecline = view.UNSAFE_getByProps({ testID: DECLINE }).props.onPress as () => void;
  act(() => setActiveUser(2));
  await flush();
  act(() => staleDecline());
  expect(saveAnswered).not.toHaveBeenCalled();
});

it('lands nothing after unmount', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const settle = heldAnswered();
  const view = render(<WritingSessionOffer result={RESULT} />);
  view.unmount();
  await act(async () => {
    settle(false);
    await Promise.resolve();
  });
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
