import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useAuthSubmit } from '../useAuthSubmit';

const FALLBACK = 'We could not complete that. Try again in a moment.';

function makeDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (_e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (_e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAuthSubmit', () => {
  it('starts with submitting false and error null', () => {
    const fn = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK }));

    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets submitting true mid-flight and clears it and any prior error on success', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK }));

    act(() => {
      result.current.setError('boom');
    });
    expect(result.current.error).toBe('boom');

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run();
    });
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      deferred.resolve();
      await runPromise;
    });

    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error to the exact fallback string on rejection and resets submitting', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK }));

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run();
    });

    await act(async () => {
      deferred.reject(new Error('network down'));
      await runPromise;
    });

    expect(result.current.error).toBe(FALLBACK);
    expect(result.current.submitting).toBe(false);
  });

  it('ignores a second run while one is already in flight', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK }));

    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    act(() => {
      firstRun = result.current.run();
      secondRun = result.current.run();
    });

    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve();
      await firstRun;
      await secondRun;
    });

    const secondDeferred = makeDeferred();
    fn.mockReturnValueOnce(secondDeferred.promise);

    let thirdRun!: Promise<void>;
    act(() => {
      thirdRun = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondDeferred.resolve();
      await thirdRun;
    });
  });

  it('keeps a stable run identity and always invokes the latest fn passed in', async () => {
    const firstFn = jest.fn(() => Promise.resolve());
    const secondFn = jest.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => Promise<void> }) => useAuthSubmit(fn, { fallback: FALLBACK }),
      { initialProps: { fn: firstFn } },
    );

    const firstRun = result.current.run;
    rerender({ fn: secondFn });
    expect(Object.is(firstRun, result.current.run)).toBe(true);

    await act(async () => {
      await result.current.run();
    });

    expect(secondFn).toHaveBeenCalledTimes(1);
    expect(firstFn).not.toHaveBeenCalled();
  });
});
