/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { Invitation } from '@/api';

type RealUseState = (_initial: unknown) => [unknown, (_next: unknown) => void];

// When armed, record every state dispatch so the unmount guard test can assert
// that no dispatch reaches the hook after it has been torn down — the one signal
// React 18 leaves observable (a post-unmount setState is otherwise a silent no-op).
let mockUnmountTrackingArmed = false;
const mockPostUnmountDispatches: unknown[] = [];

function mockWrapUseState(realUseState: unknown): (_initial: unknown) => [unknown, unknown] {
  const useStateFn = realUseState as RealUseState;
  return (initial) => {
    const [value, setValue] = useStateFn(initial);
    const trackedSetValue = (next: unknown): void => {
      if (mockUnmountTrackingArmed) mockPostUnmountDispatches.push(next);
      setValue(next);
    };
    return [value, trackedSetValue];
  };
}

jest.mock('react', () => {
  const actual = jest.requireActual('react') as Record<string, unknown>;
  return { ...actual, useState: mockWrapUseState(actual.useState) };
});

const mockList = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<Invitation[]>>;
const mockDismiss = jest.fn() as jest.MockedFunction<
  (_id: number, _token?: string) => Promise<void>
>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    invitations: {
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
      dismiss: (...a: unknown[]) => (mockDismiss as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const { useInvitations } = require('../useInvitations');

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 1,
    target_type: 'habit',
    target_id: 10,
    kind: 'consistency',
    created_at: '2026-06-24T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockDismiss.mockReset();
  mockList.mockResolvedValue([]);
  mockDismiss.mockResolvedValue(undefined);
  mockUnmountTrackingArmed = false;
  mockPostUnmountDispatches.length = 0;
});

describe('useInvitations', () => {
  it('loads one pending invitation on mount', async () => {
    mockList.mockResolvedValue([invitation({ id: 1 })]);
    const { result } = renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    expect(result.current.invitations[0].id).toBe(1);
  });

  it('resolves to empty when list returns nothing (silence)', async () => {
    mockList.mockResolvedValue([]);
    const { result } = renderHook(() => useInvitations());
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    expect(result.current.invitations).toHaveLength(0);
  });

  it('dismiss optimistically removes the item and calls invitations.dismiss once', async () => {
    mockList.mockResolvedValue([invitation({ id: 2 }), invitation({ id: 3 })]);
    let resolveDismiss: () => void = () => {};
    mockDismiss.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDismiss = resolve;
      }),
    );
    const { result } = renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.invitations).toHaveLength(2));

    act(() => {
      void result.current.dismiss(2);
    });

    expect(result.current.invitations.map((i: Invitation) => i.id)).toEqual([3]);
    expect(mockDismiss).toHaveBeenCalledWith(2);
    expect(mockDismiss).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDismiss();
    });
    expect(result.current.invitations.map((i: Invitation) => i.id)).toEqual([3]);
  });

  it('dismiss reverts the optimistic removal when the API call rejects', async () => {
    mockList.mockResolvedValue([invitation({ id: 4 }), invitation({ id: 5 })]);
    mockDismiss.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.invitations).toHaveLength(2));

    await act(async () => {
      await result.current.dismiss(4).catch(() => undefined);
    });

    expect(result.current.invitations.map((i: Invitation) => i.id)).toEqual([4, 5]);
  });

  it('per-id guard: a second dismiss for the same in-flight id does not double-fire the API', async () => {
    mockList.mockResolvedValue([invitation({ id: 6 }), invitation({ id: 7 })]);
    let resolveDismiss: () => void = () => {};
    mockDismiss.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDismiss = resolve;
      }),
    );
    const { result } = renderHook(() => useInvitations());
    await waitFor(() => expect(result.current.invitations).toHaveLength(2));

    await act(async () => {
      void result.current.dismiss(6);
      void result.current.dismiss(6);
    });

    expect(mockDismiss).toHaveBeenCalledWith(6);
    expect(mockDismiss).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDismiss();
    });
  });

  it('unmount guard: a late list resolution dispatches no state update on the dead hook', async () => {
    // A post-unmount setState is a silent no-op in React 18, so asserting on
    // `items` cannot distinguish the guard from its removal. Arm the state-
    // dispatch tracker instead and assert the late resolution reaches no setter.
    let resolveList: (_value: Invitation[]) => void = () => {};
    mockList.mockReturnValue(
      new Promise<Invitation[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useInvitations());
    unmount();
    mockUnmountTrackingArmed = true;

    await act(async () => {
      resolveList([invitation({ id: 8 })]);
      await Promise.resolve();
    });

    expect(mockPostUnmountDispatches).toHaveLength(0);
    expect(result.current.invitations).toHaveLength(0);
  });
});
