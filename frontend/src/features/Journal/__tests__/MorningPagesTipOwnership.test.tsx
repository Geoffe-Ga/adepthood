/**
 * Account-epoch guards on the morning-pages tip (#3329): its decline-state read
 * and its set-aside / never actions never land under an account other than the
 * one they started under, and a same-account set-aside made while a re-read is
 * out stays set aside when that read lands.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import MorningPagesTip from '../MorningPagesTip';

import { setActiveUser } from '@/storage/userScope';

interface TipState {
  setAsideOn: string | null;
  neverOffer: boolean;
}

const OPEN: TipState = { setAsideOn: null, neverOffer: false };
const NEVER: TipState = { setAsideOn: null, neverOffer: true };
const TIP = 'journal-morning-pages-tip';

const mockLoad = jest.fn<() => Promise<TipState>>();
const mockSaveSetAside = jest.fn<(_day: string) => Promise<void>>();
const mockSaveNever = jest.fn<(_value: boolean) => Promise<void>>();
const onBegin = jest.fn();

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: 'America/Los_Angeles' }),
}));

jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipState: () => mockLoad(),
  saveMorningPagesTipSetAside: (day: string) => mockSaveSetAside(day),
  saveMorningPagesTipNeverOffer: (value: boolean) => mockSaveNever(value),
}));

/** A decline-state read the test settles by hand. */
function heldLoad(): (_state: TipState) => void {
  let settle: (_state: TipState) => void = () => undefined;
  mockLoad.mockImplementationOnce(
    () =>
      new Promise<TipState>((resolve) => {
        settle = resolve;
      }),
  );
  return (state) => settle(state);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSaveSetAside.mockReset();
  mockSaveNever.mockReset();
  onBegin.mockReset();
  mockLoad.mockResolvedValue(OPEN);
  mockSaveSetAside.mockResolvedValue(undefined);
  mockSaveNever.mockResolvedValue(undefined);
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

it('offers the tip for the same account once its read lands', async () => {
  const settle = heldLoad();
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  expect(view.queryByTestId(TIP)).toBeNull();
  await act(async () => {
    settle(OPEN);
  });
  expect(await view.findByTestId(TIP)).toBeTruthy();
});

it('hides A’s tip at render time when B arrives, before B’s read lands', async () => {
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  await flush();
  expect(view.getByTestId(TIP)).toBeTruthy();
  heldLoad();
  act(() => setActiveUser(2));
  expect(view.queryByTestId(TIP)).toBeNull();
});

it('ignores A’s late read after A to B', async () => {
  const settleA = heldLoad();
  mockLoad.mockResolvedValueOnce(NEVER);
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  act(() => setActiveUser(2));
  await flush();
  await act(async () => {
    settleA(OPEN);
    await Promise.resolve();
  });
  expect(view.queryByTestId(TIP)).toBeNull();
});

it('ignores A’s late read after A to B to A, keeping the fresh A answer', async () => {
  const settleA = heldLoad();
  mockLoad.mockResolvedValueOnce(NEVER);
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await flush();
  expect(mockLoad).toHaveBeenCalledTimes(2);
  await act(async () => {
    settleA(OPEN);
    await Promise.resolve();
  });
  expect(view.queryByTestId(TIP)).toBeNull();
});

it('keeps a same-account set-aside made while a re-read is out', async () => {
  const view = render(<MorningPagesTip onBegin={onBegin} refreshKey={0} />);
  await flush();
  const settleReread = heldLoad();
  view.rerender(<MorningPagesTip onBegin={onBegin} refreshKey={1} />);
  fireEvent.press(view.getByTestId('journal-morning-pages-dismiss'));
  expect(mockSaveSetAside).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId(TIP)).toBeNull();
  await act(async () => {
    settleReread(OPEN);
    await Promise.resolve();
  });
  expect(view.queryByTestId(TIP)).toBeNull();
});

it('refuses a decline pressed from a stale render after the account changed', async () => {
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  await flush();
  const staleNever = view.UNSAFE_getByProps({ testID: 'journal-morning-pages-never' }).props
    .onPress as () => void;
  act(() => setActiveUser(2));
  await flush();
  act(() => staleNever());
  expect(mockSaveNever).not.toHaveBeenCalled();
  expect(view.getByTestId(TIP)).toBeTruthy();
});

it('lands nothing after unmount', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const settle = heldLoad();
  const view = render(<MorningPagesTip onBegin={onBegin} />);
  view.unmount();
  await act(async () => {
    settle(OPEN);
    await Promise.resolve();
  });
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
