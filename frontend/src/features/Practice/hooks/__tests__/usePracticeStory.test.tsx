import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeStoryResponse, UserPractice } from '@/api';
import { beginAuthSession, captureAuthScope, installSessionTokenGetter } from '@/api/sessionToken';
import { notifyPracticeRecordSaved } from '@/features/Practice/practiceRecordEvents';
import { storyFixture } from '@/features/Practice/testSupport/practiceStoryFixture';
import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

const mockList = jest.fn<(token?: string) => Promise<UserPractice[]>>();
const mockStory = jest.fn<(id: number, token?: string) => Promise<PracticeStoryResponse>>();
const jwt = (owner: number) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: String(owner), exp: 4102444800 })).toString('base64url')}.test`;
let mockToken: string | null = jwt(1);
let mockZone = 'America/Los_Angeles';
let mockReady = true;
let mockReturn: () => void;
jest.mock('@/api', () => ({
  userPractices: { list: (...args: [string?]) => mockList(...args) },
  practiceSessions: { story: (...args: [number, string?]) => mockStory(...args) },
}));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: mockToken,
    authStatus: 'authenticated',
    userTimezone: mockZone,
    userTimezoneReady: mockReady,
  }),
}));
jest.mock('@/hooks/useRefetchOnReturn', () => ({
  useRefetchOnReturn: (callback: () => void) => {
    mockReturn = callback;
  },
}));
const { usePracticeStory } = require('../usePracticeStory');
const adoption = (id = 12, stage = 1, end: string | null = null): UserPractice => ({
  id,
  practice_id: 77,
  stage_number: stage,
  start_date: '2026-05-23',
  end_date: end,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  setActiveUser(1);
  mockToken = jwt(1);
  mockZone = 'America/Los_Angeles';
  mockReady = true;
  installSessionTokenGetter(() => mockToken);
  mockList.mockReset().mockResolvedValue([adoption()]);
  mockStory.mockReset().mockResolvedValue(storyFixture());
});
afterEach(() => {
  installSessionTokenGetter(null);
  setActiveUser(null);
});
describe('usePracticeStory', () => {
  it('pins the credential and prefers a live adoption in the requested stage', async () => {
    mockList.mockResolvedValue([adoption(2, 1, '2026-06-01'), adoption(15, 8), adoption(18, 1)]);
    const { result } = renderHook(() => usePracticeStory(77, 8));
    await waitFor(() => expect(result.current.story?.total_minutes).toBe(65));
    expect(mockList).toHaveBeenCalledWith(mockToken);
    expect(mockStory).toHaveBeenCalledWith(15, mockToken);
  });
  it('is absent without an adoption and never requests the aggregate', async () => {
    mockList.mockResolvedValue([]);
    const { result } = renderHook(() => usePracticeStory(77, 1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.story).toBeNull();
    expect(mockStory).not.toHaveBeenCalled();
  });
  it.each(['missing', 'mismatch', 'calendar', 'transition'])(
    'does not dispatch while %s is unresolved',
    async (boundary) => {
      if (boundary === 'missing') mockToken = null;
      if (boundary === 'mismatch') mockToken = jwt(2);
      if (boundary === 'calendar') mockReady = false;
      if (boundary === 'transition') beginActiveUserTransition();
      renderHook(() => usePracticeStory(77, 1));
      expect(mockList).not.toHaveBeenCalled();
    },
  );
  it('does not issue the second request after owner ABA', async () => {
    const pending = deferred<UserPractice[]>();
    mockList.mockReturnValueOnce(pending.promise);
    renderHook(() => usePracticeStory(77, 1));
    await act(async () => {
      setActiveUser(2);
      setActiveUser(1);
      pending.resolve([adoption()]);
    });
    expect(mockStory).toHaveBeenCalledTimes(1);
  });
  it('drops a late answer across a new session of the same owner', async () => {
    const pending = deferred<PracticeStoryResponse>();
    mockStory.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(() => usePracticeStory(77, 1));
    await waitFor(() => expect(mockStory).toHaveBeenCalledTimes(1));
    act(() => {
      beginAuthSession();
      rerender({});
    });
    await waitFor(() => expect(mockStory).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(storyFixture({ total_minutes: 999 })));
    expect(result.current.story?.total_minutes).toBe(65);
  });
  it('refreshes on a screen return and recovers a quiet error on retry', async () => {
    mockStory.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => usePracticeStory(77, 1));
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    await act(async () => mockReturn());
    await waitFor(() => expect(result.current.story?.total_minutes).toBe(65));
    expect(result.current.error).toBeNull();
  });
  it('makes no second request for an unmounted screen', async () => {
    const pending = deferred<UserPractice[]>();
    mockList.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => usePracticeStory(77, 1));
    unmount();
    await act(async () => pending.resolve([adoption()]));
    expect(mockStory).not.toHaveBeenCalled();
  });
  it('refreshes after a confirmed save in the current scope, without stale-scope notifications', async () => {
    const { result } = renderHook(() => usePracticeStory(77, 1));
    await waitFor(() => expect(result.current.story?.total_minutes).toBe(65));
    const ended = captureAuthScope();
    act(() => {
      beginAuthSession();
    });
    act(() => {
      notifyPracticeRecordSaved(ended);
    });
    expect(mockStory).toHaveBeenCalledTimes(1);
    const current = captureAuthScope();
    mockStory.mockResolvedValue(storyFixture({ total_minutes: 95 }));
    act(() => {
      notifyPracticeRecordSaved(current);
    });
    await waitFor(() => expect(result.current.story?.total_minutes).toBe(95));
  });
});
