/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { DEFAULT_IDLE_DELAY_MS, useIdle } from '../useIdle';

afterEach(() => {
  jest.useRealTimers();
});

describe('useIdle', () => {
  it('starts not-idle and flips to idle after the delay', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));
    expect(result.current.isIdle).toBe(false);

    act(() => {
      result.current.bump();
    });
    expect(result.current.isIdle).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.isIdle).toBe(true);
  });

  it('bump resets idle back to false and restarts the timer', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));

    act(() => {
      result.current.bump();
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.isIdle).toBe(true);

    act(() => {
      result.current.bump();
    });
    expect(result.current.isIdle).toBe(false);

    act(() => {
      jest.advanceTimersByTime(999);
    });
    expect(result.current.isIdle).toBe(false); // timer restarted, not yet elapsed
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.isIdle).toBe(true);
  });

  it('defaults to DEFAULT_IDLE_DELAY_MS', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle());
    act(() => {
      result.current.bump();
      jest.advanceTimersByTime(DEFAULT_IDLE_DELAY_MS - 1);
    });
    expect(result.current.isIdle).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.isIdle).toBe(true);
  });
});

/**
 * ``settle`` exists for a surface that opens onto work that is already
 * finished: there is no activity to wait out, so waiting reads as a missing
 * feature. It is opt-in precisely so the default — not idle until things go
 * quiet — is unchanged for every consumer that does not call it.
 */
describe('useIdle settle', () => {
  it('is idle immediately, with no bump and no elapsed delay', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));
    expect(result.current.isIdle).toBe(false);

    act(() => {
      result.current.settle();
    });

    expect(result.current.isIdle).toBe(true);
  });

  it('yields to activity: a bump after settling hides it again until the pause', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));

    act(() => {
      result.current.settle();
      result.current.bump();
    });
    expect(result.current.isIdle).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.isIdle).toBe(true);
  });

  it('cancels a pending timer so a stale one cannot fight it', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));

    act(() => {
      result.current.bump();
      jest.advanceTimersByTime(500);
      result.current.settle();
    });
    expect(result.current.isIdle).toBe(true);

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.isIdle).toBe(true);
  });

  it('leaves the default alone: never idle until something asks', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useIdle({ delayMs: 1000 }));

    act(() => {
      jest.advanceTimersByTime(10_000);
    });

    expect(result.current.isIdle).toBe(false);
  });
});
