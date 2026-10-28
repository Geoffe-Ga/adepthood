/**
 * Account-epoch guards on the link-a-habit note (#3329): its mount-time flag
 * read and its decline never land under an account other than the one they
 * started under, including across A to B to A while the old read is out.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import LinkHabitNudge from '../LinkHabitNudge';

import {
  loadLinkHabitNudgeDeclined,
  saveLinkHabitNudgeDeclined,
} from '@/storage/linkHabitNudgeStorage';
import { setActiveUser } from '@/storage/userScope';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

jest.mock('@/navigation/hooks', () => ({
  useRootNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('@/api', () => ({
  uiFlags: {
    get: jest.fn(() => Promise.reject(new Error('not configured'))),
    update: jest.fn(() => Promise.reject(new Error('not configured'))),
  },
}));

jest.mock('@/storage/linkHabitNudgeStorage', () => ({
  loadLinkHabitNudgeDeclined: jest.fn(() => Promise.resolve(false)),
  saveLinkHabitNudgeDeclined: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('@/storage/writingOfferStorage', () => ({
  loadWritingOfferAnswered: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('@/utils/accessibilityFocus', () => ({ moveAccessibilityFocus: jest.fn() }));

const loadDeclined = loadLinkHabitNudgeDeclined as jest.Mock;
const saveDeclined = saveLinkHabitNudgeDeclined as jest.Mock;
const NOTE = 'link-habit-nudge';

/** A declined-flag read the test settles by hand. */
function heldDeclined(): (_declined: boolean) => void {
  let settle: (_declined: boolean) => void = () => undefined;
  loadDeclined.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
  );
  return (declined) => settle(declined);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  loadDeclined.mockImplementation(() => Promise.resolve(false));
  useWritingHabitLinkStore.getState().reset();
  useWritingHabitLinkStore.setState({ habitId: null, hydrated: true });
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

it('opens for the same account once its read lands', async () => {
  const settle = heldDeclined();
  const view = render(<LinkHabitNudge />);
  expect(view.queryByTestId(NOTE)).toBeNull();
  await act(async () => {
    settle(false);
  });
  expect(await view.findByTestId(NOTE)).toBeTruthy();
});

it('hides A’s open note at render time when B arrives, before B’s read lands', async () => {
  const view = render(<LinkHabitNudge />);
  await flush();
  expect(view.getByTestId(NOTE)).toBeTruthy();
  heldDeclined();
  act(() => setActiveUser(2));
  expect(view.queryByTestId(NOTE)).toBeNull();
});

it('ignores A’s late read after A to B', async () => {
  const settleA = heldDeclined();
  loadDeclined.mockImplementationOnce(() => Promise.resolve(true));
  const view = render(<LinkHabitNudge />);
  act(() => setActiveUser(2));
  await flush();
  await act(async () => {
    settleA(false);
    await Promise.resolve();
  });
  expect(view.queryByTestId(NOTE)).toBeNull();
});

it('ignores A’s late read after A to B to A, keeping the fresh A answer', async () => {
  const settleA = heldDeclined();
  loadDeclined.mockImplementationOnce(() => Promise.resolve(true));
  const view = render(<LinkHabitNudge />);
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await flush();
  expect(loadDeclined).toHaveBeenCalledTimes(2);
  await act(async () => {
    settleA(false);
    await Promise.resolve();
  });
  expect(view.queryByTestId(NOTE)).toBeNull();
});

it('keeps a same-account decline, and lets it lapse for the next account', async () => {
  const view = render(<LinkHabitNudge />);
  await flush();
  fireEvent.press(view.getByTestId('link-habit-nudge-decline'));
  expect(saveDeclined).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId(NOTE)).toBeNull();
  act(() => setActiveUser(2));
  await flush();
  expect(view.getByTestId(NOTE)).toBeTruthy();
});

it('refuses a decline pressed from a stale render after the account changed', async () => {
  const view = render(<LinkHabitNudge />);
  await flush();
  const staleDecline = view.UNSAFE_getByProps({ testID: 'link-habit-nudge-decline' }).props
    .onPress as () => void;
  act(() => setActiveUser(2));
  await flush();
  act(() => staleDecline());
  expect(saveDeclined).not.toHaveBeenCalled();
});

it('lands nothing after unmount', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const settle = heldDeclined();
  const view = render(<LinkHabitNudge />);
  view.unmount();
  await act(async () => {
    settle(false);
    await Promise.resolve();
  });
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
