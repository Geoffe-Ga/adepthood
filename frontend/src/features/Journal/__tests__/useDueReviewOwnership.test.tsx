import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type * as React from 'react';

import { useDueReview } from '../useDueReview';

import type { ReflectionDue } from '@/api';
import { setActiveUser } from '@/storage/userScope';

const A = 'x.eyJzdWIiOiIxIiwiZXhwIjo0MDAwMDAwMDAwfQ.y';
const B = 'x.eyJzdWIiOiIyIiwiZXhwIjo0MDAwMDAwMDAwfQ.y';
let mockToken: string | null = A;
const mockDue = jest.fn<(_token?: string) => Promise<{ due: ReflectionDue | null }>>();
const mockSaveDismissed = jest.fn<(_key: string, _value: boolean) => Promise<void>>();
const DUE: ReflectionDue = {
  level: 'week',
  scope_key: 'c1:w1',
  window_start: '2026-10-01T00:00:00Z',
  window_end: '2026-10-08T00:00:00Z',
  existing_entry_id: 41,
};

jest.mock('@/api', () => ({ reflections: { due: (token?: string) => mockDue(token) } }));
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: mockToken }) }));
jest.mock('../reviewScopes', () => ({ resolveStageTitles: async () => new Map() }));
jest.mock('@/storage/reflectionDismissalStorage', () => ({
  loadReflectionDismissed: async () => false,
  saveReflectionDismissed: (key: string, value: boolean) => mockSaveDismissed(key, value),
}));
jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
  };
});

beforeEach(() => {
  mockToken = A;
  setActiveUser(1);
  mockDue.mockReset();
  mockSaveDismissed.mockReset();
  mockSaveDismissed.mockResolvedValue(undefined);
  mockDue.mockResolvedValue({ due: DUE });
});
afterEach(() => {
  setActiveUser(null);
});

it('does not start an old-credential read in the adopted new namespace, then loads after token commit', async () => {
  const { result, rerender } = renderHook(() => useDueReview());
  await waitFor(() => expect(result.current.status).toBe('settled'));
  mockDue.mockClear();
  await act(async () => {
    setActiveUser(2);
    await Promise.resolve();
  });
  expect(mockDue).not.toHaveBeenCalled();
  expect(result.current.review).toBeNull();
  mockToken = B;
  rerender({});
  await waitFor(() => expect(mockDue).toHaveBeenCalledWith(B));
});

it.each([null, 'malformed', 'x.eyJleHAiOjQwMDAwMDAwMDB9.y'])(
  'does not treat absent or malformed credential %s as matching an account',
  async (token) => {
    mockToken = token;
    const { result } = renderHook(() => useDueReview());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDue).not.toHaveBeenCalled();
    expect(result.current.review).toBeNull();
  },
);

it('does not read into an anonymous namespace even with a decodable credential', async () => {
  setActiveUser(null);
  const { result } = renderHook(() => useDueReview());
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockDue).not.toHaveBeenCalled();
  expect(result.current.review).toBeNull();
});

it('keeps B’s confirmed review when the earlier A credential response arrives late', async () => {
  let finish!: (_value: { due: ReflectionDue | null }) => void;
  mockDue.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(() => useDueReview());
  await act(async () => {
    setActiveUser(2);
    mockToken = B;
    rerender({});
  });
  await waitFor(() => expect(result.current.status).toBe('settled'));
  await act(async () => {
    finish({ due: { ...DUE, existing_entry_id: 99 } });
  });
  expect(result.current.review?.scope.existing_entry_id).toBe(41);
  expect(mockDue).toHaveBeenLastCalledWith(B);
});

it('rejects A’s held due read after A to B to A, keeping the fresh A answer', async () => {
  let finish!: (_value: { due: ReflectionDue | null }) => void;
  mockDue.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = renderHook(() => useDueReview());
  await act(async () => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await waitFor(() => expect(result.current.status).toBe('settled'));
  expect(mockDue).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish({ due: { ...DUE, existing_entry_id: 99 } });
  });
  expect(result.current.review?.scope.existing_entry_id).toBe(41);
});

it('lands nothing from a held read after unmount', async () => {
  let finish!: (_value: { due: ReflectionDue | null }) => void;
  mockDue.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, unmount } = renderHook(() => useDueReview());
  unmount();
  await act(async () => {
    finish({ due: DUE });
  });
  expect(result.current.status).toBe('loading');
});

it('refuses a dismissal from a stale callback after the account changed', async () => {
  const { result } = renderHook(() => useDueReview());
  await waitFor(() => expect(result.current.review).not.toBeNull());
  const staleDismiss = result.current.dismiss;
  await act(async () => {
    setActiveUser(2);
  });
  act(() => staleDismiss());
  expect(mockSaveDismissed).not.toHaveBeenCalled();
});

it('sets the review aside for the same account', async () => {
  const { result } = renderHook(() => useDueReview());
  await waitFor(() => expect(result.current.review).not.toBeNull());
  act(() => result.current.dismiss());
  expect(mockSaveDismissed).toHaveBeenCalledWith(DUE.scope_key, true);
  expect(result.current).toMatchObject({ status: 'settled', review: null });
});
