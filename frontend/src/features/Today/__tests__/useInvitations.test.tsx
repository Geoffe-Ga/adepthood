/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { Invitation } from '@/api';

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
});
