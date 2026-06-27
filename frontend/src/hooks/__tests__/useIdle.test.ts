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
