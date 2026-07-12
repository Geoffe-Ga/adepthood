/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import type { Dispatch, SetStateAction } from 'react';

import { optimisticRemove, type OptimisticRemoveDeps } from '../optimisticRemove';

import { ApiError } from '@/api';
import { formatApiError } from '@/api/errorMessages';

interface Row {
  id: number;
}

type RemoveFn = (_id: number) => Promise<unknown>;

// Sorted re-insertion for reverting an optimistic removal.
function reinsert(prev: Row[], item: Row): Row[] {
  return [...prev, item].sort((a, b) => a.id - b.id);
}

// A remote-delete stub that resolves, typed to the helper's contract.
function resolvedRemove(): jest.MockedFunction<RemoveFn> {
  const fn = jest.fn() as jest.MockedFunction<RemoveFn>;
  fn.mockResolvedValue(undefined);
  return fn;
}

// A remote-delete stub that rejects with the given error.
function rejectedRemove(err: unknown): jest.MockedFunction<RemoveFn> {
  const fn = jest.fn() as jest.MockedFunction<RemoveFn>;
  fn.mockRejectedValue(err);
  return fn;
}

// A remote-delete stub whose promise the caller resolves by hand.
function deferredRemove(): { fn: jest.MockedFunction<RemoveFn>; resolve: () => void } {
  let resolve: () => void = () => {};
  const fn = jest.fn() as jest.MockedFunction<RemoveFn>;
  fn.mockReturnValue(
    new Promise<void>((res) => {
      resolve = res;
    }),
  );
  return { fn, resolve: () => resolve() };
}

// A tiny setState-shaped harness backed by a plain closure variable.
function makeHarness(initial: Row[]) {
  let items: Row[] = initial;
  const setItems = jest.fn((updater: Row[] | ((_prev: Row[]) => Row[])) => {
    items = typeof updater === 'function' ? (updater as (_prev: Row[]) => Row[])(items) : updater;
  }) as unknown as Dispatch<SetStateAction<Row[]>>;
  return { getItems: () => items, setItems };
}

function baseDeps(overrides: Partial<OptimisticRemoveDeps<Row>> = {}): OptimisticRemoveDeps<Row> {
  const harness = makeHarness([{ id: 1 }, { id: 2 }]);
  return {
    pendingIds: new Set<number>(),
    current: harness.getItems(),
    setItems: harness.setItems,
    removeRemote: resolvedRemove(),
    reinsert,
    onError: jest.fn(),
    ...overrides,
  };
}

describe('optimisticRemove', () => {
  it('removes the row optimistically before removeRemote resolves', async () => {
    const removeRemote = deferredRemove();
    const harness = makeHarness([{ id: 1 }, { id: 2 }]);
    const pendingIds = new Set<number>();
    const onError = jest.fn();

    const promise = optimisticRemove(1, {
      pendingIds,
      current: harness.getItems(),
      setItems: harness.setItems,
      removeRemote: removeRemote.fn,
      reinsert,
      onError,
    });

    expect(harness.getItems()).toEqual([{ id: 2 }]);
    expect(removeRemote.fn).toHaveBeenCalledWith(1);

    removeRemote.resolve();
    await promise;
  });

  it('reverts via reinsert and reports the formatted error on rejection', async () => {
    const err = new ApiError(500, 'boom');
    const removeRemote = rejectedRemove(err);
    const harness = makeHarness([{ id: 1 }, { id: 2 }]);
    const pendingIds = new Set<number>();
    const onError = jest.fn();

    await optimisticRemove(1, {
      pendingIds,
      current: harness.getItems(),
      setItems: harness.setItems,
      removeRemote,
      reinsert,
      onError,
    });

    expect(harness.getItems()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(formatApiError(err));
  });

  it('is a no-op on a second call for the same id while the first is pending', async () => {
    const removeRemote = deferredRemove();
    const harness = makeHarness([{ id: 1 }]);
    const pendingIds = new Set<number>();
    const onError = jest.fn();
    const deps = {
      pendingIds,
      current: harness.getItems(),
      setItems: harness.setItems,
      removeRemote: removeRemote.fn,
      reinsert,
      onError,
    };

    const first = optimisticRemove(1, deps);
    const second = optimisticRemove(1, deps);
    removeRemote.resolve();
    await Promise.all([first, second]);

    expect(removeRemote.fn).toHaveBeenCalledTimes(1);
  });

  it('clears pendingIds in finally on success', async () => {
    const pendingIds = new Set<number>();
    const deps = baseDeps({ pendingIds });

    await optimisticRemove(1, deps);

    expect(pendingIds.has(1)).toBe(false);
  });

  it('clears pendingIds in finally on rejection', async () => {
    const pendingIds = new Set<number>();
    const deps = baseDeps({ pendingIds, removeRemote: rejectedRemove(new ApiError(500, 'boom')) });

    await optimisticRemove(1, deps);

    expect(pendingIds.has(1)).toBe(false);
  });

  it('clears pendingIds in finally when the id is not present in current', async () => {
    const harness = makeHarness([{ id: 2 }]);
    const pendingIds = new Set<number>();
    const removeRemote = resolvedRemove();
    const onError = jest.fn();

    await optimisticRemove(1, {
      pendingIds,
      current: harness.getItems(),
      setItems: harness.setItems,
      removeRemote,
      reinsert,
      onError,
    });

    expect(pendingIds.has(1)).toBe(false);
    expect(removeRemote).toHaveBeenCalledWith(1);
    expect(harness.getItems()).toEqual([{ id: 2 }]);
  });

  it('invokes beforeStart exactly once before the optimistic mutation', async () => {
    const order: string[] = [];
    let items: Row[] = [{ id: 1 }];
    const setItems = jest.fn((updater: Row[] | ((_prev: Row[]) => Row[])) => {
      order.push('setItems');
      items = typeof updater === 'function' ? (updater as (_prev: Row[]) => Row[])(items) : updater;
    }) as unknown as Dispatch<SetStateAction<Row[]>>;
    const beforeStart = jest.fn(() => order.push('beforeStart'));
    const removeRemote = resolvedRemove();
    const onError = jest.fn();

    await optimisticRemove(1, {
      pendingIds: new Set<number>(),
      current: items,
      setItems,
      removeRemote,
      reinsert,
      onError,
      beforeStart,
    });

    expect(beforeStart).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['beforeStart', 'setItems']);
  });

  it('does not throw when beforeStart is omitted', async () => {
    const deps = baseDeps();

    await expect(optimisticRemove(1, deps)).resolves.toBeUndefined();
  });

  it('never calls onError or reinsert on the success path', async () => {
    const harness = makeHarness([{ id: 1 }, { id: 2 }]);
    const pendingIds = new Set<number>();
    const onError = jest.fn();
    const reinsertSpy = jest.fn(reinsert);
    const removeRemote = resolvedRemove();

    await optimisticRemove(1, {
      pendingIds,
      current: harness.getItems(),
      setItems: harness.setItems,
      removeRemote,
      reinsert: reinsertSpy,
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(reinsertSpy).not.toHaveBeenCalled();
    expect(harness.getItems()).toEqual([{ id: 2 }]);
  });
});
