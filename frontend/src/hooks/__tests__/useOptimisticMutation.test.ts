import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useOptimisticMutation } from '../useOptimisticMutation';

describe('useOptimisticMutation', () => {
  it('runs apply → commit → onSuccess in order on a successful round-trip', async () => {
    const calls: string[] = [];
    const apply = jest.fn(() => {
      calls.push('apply');
    });
    const commit = jest.fn(async () => {
      calls.push('commit');
      return 'ok';
    });
    const rollback = jest.fn();
    const onSuccess = jest.fn(() => {
      calls.push('onSuccess');
    });

    const { result } = renderHook(() =>
      useOptimisticMutation({ apply, commit, rollback, onSuccess }),
    );

    await act(async () => {
      await result.current.mutate({ value: 1 });
    });

    expect(calls).toEqual(['apply', 'commit', 'onSuccess']);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('runs apply then rollback (not onSuccess) when commit rejects', async () => {
    const apply = jest.fn();
    const failure = new Error('boom');
    const commit = jest.fn(async () => {
      throw failure;
    });
    const rollback = jest.fn();
    const onSuccess = jest.fn();

    const { result } = renderHook(() =>
      useOptimisticMutation({ apply, commit, rollback, onSuccess }),
    );

    await act(async () => {
      await expect(result.current.mutate({ value: 'x' })).rejects.toThrow('boom');
    });

    expect(apply).toHaveBeenCalledWith({ value: 'x' });
    expect(rollback).toHaveBeenCalledWith({ value: 'x' }, failure);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('wraps non-Error throws so rollback always sees an Error', async () => {
    const apply = jest.fn();
    const commit = jest.fn(async () => {
      throw 'string-thrown';
    });
    const rollback = jest.fn();

    const { result } = renderHook(() => useOptimisticMutation({ apply, commit, rollback }));

    await act(async () => {
      await expect(result.current.mutate(42)).rejects.toBeDefined();
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    const [, err] = rollback.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('string-thrown');
  });

  it('toggles `pending` true during commit and false after settle (success)', async () => {
    let resolveCommit: ((value: number) => void) | undefined;
    const apply = jest.fn();
    const commit = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const rollback = jest.fn();

    const { result } = renderHook(() => useOptimisticMutation({ apply, commit, rollback }));
    expect(result.current.pending).toBe(false);

    let mutatePromise: Promise<number> | undefined;
    act(() => {
      mutatePromise = result.current.mutate(1);
    });
    // Allow the synchronous setPending(true) to flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      resolveCommit!(99);
      await mutatePromise;
    });
    expect(result.current.pending).toBe(false);
  });

  it('toggles `pending` false after a rejected commit (does not stick true)', async () => {
    const apply = jest.fn();
    const commit = jest.fn(async () => {
      throw new Error('nope');
    });
    const rollback = jest.fn();

    const { result } = renderHook(() => useOptimisticMutation({ apply, commit, rollback }));
    await act(async () => {
      await expect(result.current.mutate(1)).rejects.toThrow('nope');
    });
    expect(result.current.pending).toBe(false);
  });

  it('pending tracks the union of overlapping mutate calls (#271)', async () => {
    let resolveFirst: (_v: string) => void = () => {};
    let resolveSecond: (_v: string) => void = () => {};
    const commit = jest
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolveSecond = r;
          }),
      );

    const { result } = renderHook(() =>
      useOptimisticMutation({ apply: jest.fn(), commit, rollback: jest.fn() }),
    );

    let first: Promise<string> = Promise.resolve('');
    let second: Promise<string> = Promise.resolve('');
    await act(async () => {
      first = result.current.mutate({});
      second = result.current.mutate({});
    });
    expect(result.current.pending).toBe(true);

    // The SECOND call settles while the first is still in flight. A naive
    // boolean would flip pending to false here and re-enable a Save
    // button mid-request — the double-tap bug this guard exists to catch.
    await act(async () => {
      resolveSecond('second');
      await second;
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      resolveFirst('first');
      await first;
    });
    expect(result.current.pending).toBe(false);
  });

  it('keeps a stable `mutate` reference across re-renders even when callers pass fresh cfg', async () => {
    let renderConfig = {
      apply: jest.fn(),
      commit: jest.fn(async () => 'a'),
      rollback: jest.fn(),
    };
    const { result, rerender } = renderHook(() => useOptimisticMutation(renderConfig));

    const firstMutate = result.current.mutate;

    // Simulate a parent re-render that recreates the cfg object.
    renderConfig = {
      apply: jest.fn(),
      commit: jest.fn(async () => 'b'),
      rollback: jest.fn(),
    };
    rerender({});
    expect(result.current.mutate).toBe(firstMutate);

    // Latest cfg wins — the second render's commit should be the one called.
    await act(async () => {
      await result.current.mutate(undefined as never);
    });
    expect(renderConfig.commit).toHaveBeenCalledTimes(1);
  });
});
