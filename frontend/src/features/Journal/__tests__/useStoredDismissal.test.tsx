/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useStoredDismissal } from '../useStoredDismissal';

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
