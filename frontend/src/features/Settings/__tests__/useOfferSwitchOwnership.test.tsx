/**
 * Account-epoch guards on a Settings offer switch (#3329): a read or write that
 * started under one account never lands under another, including when the
 * device goes A to B and back to A while the old work is still out.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { OfferSwitchStorage } from '../journalOfferSwitches';
import { useOfferSwitch } from '../useOfferSwitch';

import { setActiveUser } from '@/storage/userScope';

interface Held<T> {
  promise: Promise<T>;
  settle: (_value: T) => void;
}

/** A promise the test settles by hand, so "still out" is a real state. */
function held<T>(): Held<T> {
  let settle: (_value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function storageOf(
  reads: Promise<boolean>[],
  writes: Promise<boolean>[] = [],
): {
  storage: OfferSwitchStorage;
  read: jest.Mock<() => Promise<boolean>>;
  write: jest.Mock<(_offered: boolean) => Promise<boolean>>;
} {
  const read = jest.fn(() => reads.shift() ?? Promise.resolve(true));
  const write = jest.fn((_offered: boolean) => writes.shift() ?? Promise.resolve(true));
  return { storage: { read, write }, read, write };
}

beforeEach(() => {
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

it('shows the stored position once the same account’s read lands', async () => {
  const { storage } = storageOf([Promise.resolve(false)]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  expect(result.current.busy).toBe(true);
  await flush();
  expect(result.current).toMatchObject({ value: false, busy: false });
});

it('writes, then shows the new position only once the write lands', async () => {
  const write = held<boolean>();
  const { storage } = storageOf([Promise.resolve(true)], [write.promise]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  await flush();
  act(() => result.current.set(false));
  expect(result.current).toMatchObject({ value: true, busy: true });
  await act(async () => {
    write.settle(true);
    await Promise.resolve();
  });
  expect(result.current).toMatchObject({ value: false, busy: false });
});

it('drops A’s position at render time when B arrives, before B’s read lands', async () => {
  const bRead = held<boolean>();
  const { storage } = storageOf([Promise.resolve(false), bRead.promise]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  await flush();
  expect(result.current.value).toBe(false);
  act(() => setActiveUser(2));
  expect(result.current).toMatchObject({ value: true, busy: true });
});

it('ignores A’s late read after A to B', async () => {
  const aRead = held<boolean>();
  const { storage } = storageOf([aRead.promise, Promise.resolve(true)]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  act(() => setActiveUser(2));
  await flush();
  await act(async () => {
    aRead.settle(false);
    await Promise.resolve();
  });
  expect(result.current).toMatchObject({ value: true, busy: false });
});

it('ignores A’s late read after A to B to A, keeping the fresh A answer', async () => {
  const aRead = held<boolean>();
  const { storage, read } = storageOf([aRead.promise, Promise.resolve(true)]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    aRead.settle(false);
    await Promise.resolve();
  });
  expect(result.current).toMatchObject({ value: true, busy: false });
});

it('ignores A’s late write after A to B to A', async () => {
  const aWrite = held<boolean>();
  const { storage } = storageOf([Promise.resolve(true), Promise.resolve(true)], [aWrite.promise]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  await flush();
  act(() => result.current.set(false));
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await flush();
  await act(async () => {
    aWrite.settle(true);
    await Promise.resolve();
  });
  expect(result.current).toMatchObject({ value: true, busy: false });
});

it('refuses a move made by a stale callback after the account changed', async () => {
  const { storage, write } = storageOf([Promise.resolve(true), Promise.resolve(true)]);
  const { result } = renderHook(() => useOfferSwitch(storage));
  await flush();
  const staleSet = result.current.set;
  act(() => setActiveUser(2));
  await flush();
  act(() => staleSet(false));
  expect(write).not.toHaveBeenCalled();
});

it('lands nothing after unmount', async () => {
  const aRead = held<boolean>();
  const { storage } = storageOf([aRead.promise]);
  const { result, unmount } = renderHook(() => useOfferSwitch(storage));
  unmount();
  await act(async () => {
    aRead.settle(false);
    await Promise.resolve();
  });
  expect(result.current).toMatchObject({ value: true, busy: true });
});
