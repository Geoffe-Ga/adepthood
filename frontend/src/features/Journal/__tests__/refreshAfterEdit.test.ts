/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useRefreshAfterEdit } from '../refreshAfterEdit';

type Refresher = () => Promise<void>;

describe('useRefreshAfterEdit (#2891)', () => {
  it('fires nothing on a save that did not follow a confirmed edit', () => {
    const refresher = jest.fn<Refresher>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRefreshAfterEdit());
    result.current.refreshersRef.current = [refresher];
    act(() => result.current.handleSaved());
    expect(refresher).not.toHaveBeenCalled();
  });

  it('fires every refresher once on the first save after a confirmed edit', () => {
    const notes = jest.fn<Refresher>().mockResolvedValue(undefined);
    const quotes = jest.fn<Refresher>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRefreshAfterEdit());
    result.current.refreshersRef.current = [notes, quotes];
    act(() => result.current.onConfirmEdit());
    act(() => result.current.handleSaved());
    act(() => result.current.handleSaved());
    expect(notes).toHaveBeenCalledTimes(1);
    expect(quotes).toHaveBeenCalledTimes(1);
  });

  it('a refresher that rejects neither blocks the others nor escapes as unhandled', async () => {
    const failing = jest.fn<Refresher>().mockRejectedValue(new Error('offline'));
    const quotes = jest.fn<Refresher>().mockResolvedValue(undefined);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { result } = renderHook(() => useRefreshAfterEdit());
      result.current.refreshersRef.current = [failing, quotes];
      act(() => result.current.onConfirmEdit());
      await act(async () => {
        result.current.handleSaved();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(quotes).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
