/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { renderHook, act } from '@testing-library/react-native';

const mockWheelGet = jest.fn() as jest.Mock;
jest.mock('../../../../api', () => ({
  wheel: { get: (...args: unknown[]) => mockWheelGet(...args) },
}));

import type { WheelBalance } from '../../../../api';
import { useWheelBalance } from '../useWheelBalance';

/** Build a 10-aspect payload (all zeros unless overridden). */
function makeWheel(overrides: Partial<Record<number, number>> = {}): WheelBalance {
  const aspects = Array.from({ length: 10 }, (_, i) => {
    const stage = i + 1;
    return {
      stage_number: stage,
      aspect: `Aspect ${stage}`,
      fullness: overrides[stage] ?? 0.0,
    };
  });
  return { aspects };
}

beforeEach(() => {
  mockWheelGet.mockReset();
});

describe('useWheelBalance', () => {
  it('resolves fullnessByStage keyed by stage_number', async () => {
    mockWheelGet.mockResolvedValueOnce(makeWheel({ 3: 0.85, 7: 0.4 }));
    const { result } = renderHook(() => useWheelBalance());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.fullnessByStage[3]).toBe(0.85);
    expect(result.current.fullnessByStage[7]).toBe(0.4);
    expect(result.current.fullnessByStage[1]).toBe(0.0);
  });

  it('exposes loading=true during fetch then loading=false on resolve', async () => {
    let resolve!: (v: WheelBalance) => void;
    mockWheelGet.mockReturnValueOnce(
      new Promise<WheelBalance>((r) => {
        resolve = r;
      }),
    );

    const { result } = renderHook(() => useWheelBalance());

    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolve(makeWheel({ 1: 0.5 }));
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
  });

  it('on fetch error sets error and leaves fullnessByStage empty (all-thin fallback)', async () => {
    mockWheelGet.mockRejectedValueOnce(new Error('network error'));
    const { result } = renderHook(() => useWheelBalance());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBeTruthy();
    expect(Object.keys(result.current.fullnessByStage)).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  it('all-zero response produces fullnessByStage all zeros without crash', async () => {
    mockWheelGet.mockResolvedValueOnce(makeWheel());
    const { result } = renderHook(() => useWheelBalance());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBeFalsy();
    for (let stage = 1; stage <= 10; stage += 1) {
      expect(result.current.fullnessByStage[stage]).toBe(0.0);
    }
  });
});
