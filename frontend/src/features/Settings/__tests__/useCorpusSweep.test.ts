/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
type SweepResult = { entries_pending: number; entries_sorted: number; entries_remaining: number };

const mockSweepEstimate = jest.fn<Promise<{ entries_pending: number }>, []>();
const mockSweep = jest.fn<Promise<SweepResult>, []>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    corpus: { sweepEstimate: () => mockSweepEstimate(), sweep: () => mockSweep() },
  };
});

import { act, renderHook } from '@testing-library/react-native';

import { refreshSweepEstimate, runSweepPass, useCorpusSweepPending } from '../useCorpusSweep';

import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';

/**
 * The backlog count the hub row and the screen share (#3499), held to the
 * account it was read for.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  setActiveUser(null);
});

describe('the shared sweep count', () => {
  test('publishes a read, and what a pass left behind', async () => {
    const { result } = renderHook(() => useCorpusSweepPending());
    expect(result.current).toBeNull();

    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 41 });
    await act(async () => {
      await expect(refreshSweepEstimate()).resolves.toBe(true);
    });
    expect(result.current).toBe(41);

    mockSweep.mockResolvedValueOnce({
      entries_pending: 1,
      entries_sorted: 40,
      entries_remaining: 1,
    });
    await act(async () => {
      await runSweepPass();
    });
    expect(result.current).toBe(1);
  });

  test('a failed read makes the count unknown rather than leaving an old one standing', async () => {
    const { result } = renderHook(() => useCorpusSweepPending());
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 41 });
    await act(async () => {
      await refreshSweepEstimate();
    });

    mockSweepEstimate.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await expect(refreshSweepEstimate()).resolves.toBe(false);
    });

    expect(result.current).toBeNull();
  });

  test('drops a read that lands after the account changed', async () => {
    const { result } = renderHook(() => useCorpusSweepPending());
    const late = deferred<{ entries_pending: number }>();
    mockSweepEstimate.mockReturnValueOnce(late.promise);

    const read = refreshSweepEstimate();
    act(() => {
      setActiveUser(2);
      resetAllStores();
    });
    await act(async () => {
      late.resolve({ entries_pending: 99 });
      await expect(read).resolves.toBe(false);
    });

    expect(result.current).toBeNull();
  });

  test('drops a pass that lands after the account changed', async () => {
    const { result } = renderHook(() => useCorpusSweepPending());
    const late = deferred<SweepResult>();
    mockSweep.mockReturnValueOnce(late.promise);

    const pass = runSweepPass();
    act(() => {
      resetAllStores();
    });
    await act(async () => {
      late.resolve({ entries_pending: 5, entries_sorted: 1, entries_remaining: 5 });
      await expect(pass).resolves.toBeNull();
    });

    expect(result.current).toBeNull();
  });

  test('a failed read for an account no longer here leaves the new account alone', async () => {
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 7 });
    await refreshSweepEstimate();
    const { result } = renderHook(() => useCorpusSweepPending());
    const late = deferred<{ entries_pending: number }>();
    mockSweepEstimate.mockReturnValueOnce(late.promise.then(() => Promise.reject(new Error('x'))));

    const read = refreshSweepEstimate();
    act(() => {
      resetAllStores();
    });
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 3 });
    await act(async () => {
      await refreshSweepEstimate();
      late.resolve({ entries_pending: 0 });
      await read;
    });

    expect(result.current).toBe(3);
  });
});
