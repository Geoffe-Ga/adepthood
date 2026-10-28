/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useStoredDismissal } from '../useStoredDismissal';

import { setActiveUser } from '@/storage/userScope';

/** A load the test settles by hand, so "the read is still out" is a real state. */
function heldLoad(): { load: jest.Mock<() => Promise<boolean>>; settle: (_v: boolean) => void } {
  let settle: (_v: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { load: jest.fn(() => promise), settle };
}

const noSave = (): Promise<void> => Promise.resolve();

describe('useStoredDismissal', () => {
  it('reads the stored answer once at mount, however many presses ask', async () => {
    const load = jest.fn(() => Promise.resolve(false));
    const { result } = renderHook(() => useStoredDismissal(load, noSave));

    await act(async () => {
      await result.current.read();
      await result.current.read();
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is unknown while the read is out, then holds the stored answer', async () => {
    const { load, settle } = heldLoad();
    const { result } = renderHook(() => useStoredDismissal(load, noSave));
    expect(result.current.known()).toBeNull();

    await act(async () => {
      settle(true);
      await result.current.read();
    });

    expect(result.current.known()).toBe(true);
  });

  it('a dismissal holds in memory before its write lands', () => {
    const { load } = heldLoad();
    const save = jest.fn(() => new Promise<void>(() => undefined));
    const { result } = renderHook(() => useStoredDismissal(load, save));

    act(() => result.current.markDismissed());

    expect(result.current.known()).toBe(true);
    expect(save).toHaveBeenCalledWith(true);
  });
});

it('does not let the initial read undo a dismissal made while it was pending', async () => {
  const { load, settle } = heldLoad();
  const { result } = renderHook(() => useStoredDismissal(load, noSave));
  act(() => result.current.markDismissed());
  await act(async () => {
    settle(false);
    await Promise.resolve();
  });
  expect(result.current.known()).toBe(true);
});

it('drops the old account answer and ignores its late read after owner replacement', async () => {
  setActiveUser(1);
  const first = heldLoad();
  const second = heldLoad();
  const load = jest
    .fn()
    .mockImplementationOnce(first.load)
    .mockImplementationOnce(second.load) as jest.Mock<() => Promise<boolean>>;
  const { result, rerender, unmount } = renderHook(() => useStoredDismissal(load, noSave));
  act(() => {
    setActiveUser(2);
    rerender({});
  });
  await act(async () => {
    first.settle(true);
    await Promise.resolve();
  });
  expect(result.current.known()).toBeNull();
  await act(async () => {
    second.settle(false);
    await result.current.read();
  });
  expect(result.current.known()).toBe(false);
  unmount();
  setActiveUser(null);
});

it('rejects an old A read after A to B to A even when React batches the switch', async () => {
  setActiveUser(1);
  const first = heldLoad();
  const second = heldLoad();
  const load = jest
    .fn()
    .mockImplementationOnce(first.load)
    .mockImplementationOnce(second.load) as jest.Mock<() => Promise<boolean>>;
  const { result, unmount } = renderHook(() => useStoredDismissal(load, noSave));
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await act(async () => {
    first.settle(true);
    await Promise.resolve();
  });
  expect(result.current.known()).toBeNull();
  await act(async () => {
    second.settle(false);
    await result.current.read();
  });
  expect(result.current.known()).toBe(false);
  unmount();
  setActiveUser(null);
});

it('refuses a dismissal from a stale callback after the account changed', () => {
  setActiveUser(1);
  const { load } = heldLoad();
  const save = jest.fn(() => Promise.resolve());
  const { result, unmount } = renderHook(() => useStoredDismissal(load, save));
  const staleDismiss = result.current.markDismissed;
  act(() => setActiveUser(2));
  act(() => staleDismiss());
  expect(save).not.toHaveBeenCalled();
  expect(result.current.known()).toBeNull();
  unmount();
  setActiveUser(null);
});

it('answers a stale read “not dismissed” once its account has been replaced', async () => {
  setActiveUser(1);
  const first = heldLoad();
  const { result, unmount } = renderHook(() => useStoredDismissal(first.load, noSave));
  const staleRead = result.current.read();
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  first.settle(true);
  await expect(staleRead).resolves.toBe(false);
  unmount();
  setActiveUser(null);
});
