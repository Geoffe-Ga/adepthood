import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { ApiProgressOverview } from '@/api';
import { beginAuthSession, installSessionTokenGetter } from '@/api/sessionToken';
import { progressOverviewFixture } from '@/features/Map/testSupport/progressOverviewFixture';
import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

const mockOverview = jest.fn<(token?: string) => Promise<ApiProgressOverview>>();
const jwt = (owner: number) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: String(owner), exp: 4102444800 })).toString('base64url')}.test`;
let mockToken: string | null = jwt(1);
let mockReady = true;
let mockReturn: () => void = () => undefined;
jest.mock('@/api', () => ({
  progress: { overview: (...args: [string?]) => mockOverview(...args) },
}));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: mockToken,
    authStatus: 'authenticated',
    userTimezone: 'UTC',
    userTimezoneReady: mockReady,
  }),
}));
jest.mock('@/hooks/useRefetchOnReturn', () => ({
  useRefetchOnReturn: (callback: () => void) => {
    mockReturn = callback;
  },
}));
const { useProgressOverview } = require('../useProgressOverview');

beforeEach(() => {
  setActiveUser(1);
  mockToken = jwt(1);
  mockReady = true;
  installSessionTokenGetter(() => mockToken);
  mockOverview.mockReset().mockResolvedValue(progressOverviewFixture());
});
afterEach(() => {
  installSessionTokenGetter(null);
  setActiveUser(null);
});

describe('useProgressOverview', () => {
  it('reads with the pinned credential and re-reads on return, holding the old figures', async () => {
    const { result } = renderHook(() => useProgressOverview());
    await waitFor(() => expect(result.current.overview?.arc.current_week).toBe(23));
    expect(mockOverview).toHaveBeenCalledWith(mockToken);
    let resolve!: (value: ApiProgressOverview) => void;
    mockOverview.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    act(() => mockReturn());
    expect(result.current.loading).toBe(true);
    expect(result.current.overview?.arc.current_week).toBe(23);
    const later = progressOverviewFixture();
    later.arc.current_week = 24;
    await act(async () => resolve(later));
    expect(result.current.overview?.arc.current_week).toBe(24);
  });

  it.each(['missing', 'mismatch', 'calendar', 'transition'])(
    'does not dispatch while %s is unresolved',
    (boundary) => {
      if (boundary === 'missing') mockToken = null;
      if (boundary === 'mismatch') mockToken = jwt(2);
      if (boundary === 'calendar') mockReady = false;
      if (boundary === 'transition') beginActiveUserTransition();
      renderHook(() => useProgressOverview());
      expect(mockOverview).not.toHaveBeenCalled();
    },
  );

  it('drops a late answer across a new session and recovers an error on retry', async () => {
    let resolve!: (value: ApiProgressOverview) => void;
    mockOverview
      .mockReturnValueOnce(new Promise((done) => (resolve = done)))
      .mockRejectedValueOnce('offline');
    const { result, rerender } = renderHook(() => useProgressOverview());
    act(() => {
      beginAuthSession();
      rerender({});
    });
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    await act(async () => resolve(progressOverviewFixture()));
    expect(result.current.overview).toBeNull();
    await act(async () => result.current.refresh());
    expect(result.current.overview?.arc.current_week).toBe(23);
  });
});
