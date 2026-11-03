/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
type Run = {
  id: number;
  lane: 'app_provider' | 'vault_bound';
  state: 'running' | 'completed' | 'stopped' | 'failed';
  stop_reason: null;
  entries_total: number;
  entries_offered: number;
  entries_sorted: number;
  started_at: string;
  finished_at: string | null;
};
type Estimate = { entries_pending: number; run?: Run | null };
type SweepResult = Estimate & { entries_sorted: number; entries_remaining: number };

const mockSweepEstimate = jest.fn<Promise<Estimate>, []>();
const mockSweep = jest.fn<Promise<SweepResult>, []>();

const RUNNING: Run = {
  id: 7,
  lane: 'app_provider',
  state: 'running',
  stop_reason: null,
  entries_total: 41,
  entries_offered: 0,
  entries_sorted: 0,
  started_at: '2026-11-03T10:00:00Z',
  finished_at: null,
};

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    corpus: { sweepEstimate: () => mockSweepEstimate(), sweep: () => mockSweep() },
  };
});

import { act, renderHook } from '@testing-library/react-native';

import {
  refreshSweepEstimate,
  startSort,
  useCorpusSortRun,
  useCorpusSweepPending,
} from '../useCorpusSweep';

import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';

/**
 * The backlog count and latest sort the hub row and the screen share (#3499),
 * held to the account they were read for.
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
  test('publishes a read, and the run a press started', async () => {
    const { result } = renderHook(() => ({
      pending: useCorpusSweepPending(),
      run: useCorpusSortRun(),
    }));
    expect(result.current).toEqual({ pending: null, run: null });

    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 41, run: null });
    await act(async () => {
      await expect(refreshSweepEstimate()).resolves.toBe(true);
    });
    expect(result.current).toEqual({ pending: 41, run: null });

    mockSweep.mockResolvedValueOnce({
      entries_pending: 41,
      entries_sorted: 0,
      entries_remaining: 41,
      run: RUNNING,
    });
    await act(async () => {
      await startSort();
    });
    expect(result.current).toEqual({ pending: 41, run: RUNNING });
  });

  test('a later read replaces the run with how far it has got', async () => {
    const { result } = renderHook(() => useCorpusSortRun());
    const later = { ...RUNNING, entries_offered: 20, entries_sorted: 18 };
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 23, run: later });

    await act(async () => {
      await refreshSweepEstimate();
    });

    expect(result.current).toEqual(later);
  });

  test('a server that sends no run reads as no run', async () => {
    const { result } = renderHook(() => useCorpusSortRun());
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 5 });

    await act(async () => {
      await refreshSweepEstimate();
    });

    expect(result.current).toBeNull();
  });

  test('an account boundary clears the run with the count', async () => {
    const { result } = renderHook(() => useCorpusSortRun());
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 41, run: RUNNING });
    await act(async () => {
      await refreshSweepEstimate();
    });

    act(() => {
      resetAllStores();
    });

    expect(result.current).toBeNull();
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
    const late = deferred<Estimate>();
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

  test('drops a press that lands after the account changed', async () => {
    const { result } = renderHook(() => ({
      pending: useCorpusSweepPending(),
      run: useCorpusSortRun(),
    }));
    const late = deferred<SweepResult>();
    mockSweep.mockReturnValueOnce(late.promise);

    const press = startSort();
    act(() => {
      resetAllStores();
    });
    await act(async () => {
      late.resolve({ entries_pending: 5, entries_sorted: 0, entries_remaining: 5, run: RUNNING });
      await expect(press).resolves.toBeNull();
    });

    expect(result.current).toEqual({ pending: null, run: null });
  });

  test('a failed read for an account no longer here leaves the new account alone', async () => {
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 7 });
    await refreshSweepEstimate();
    const { result } = renderHook(() => useCorpusSweepPending());
    const late = deferred<Estimate>();
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
