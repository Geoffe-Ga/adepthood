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
  saveReflectionDismissed: async () => undefined,
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
