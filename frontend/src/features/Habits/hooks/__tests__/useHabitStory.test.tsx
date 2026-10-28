import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { ApiHabitStory } from '@/api';
import { beginAuthSession, installSessionTokenGetter } from '@/api/sessionToken';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitStoryFixture, storyHabit } from '@/features/Habits/testSupport/habitStoryFixture';
import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

const mockGetStory = jest.fn<(id: number, token?: string) => Promise<ApiHabitStory>>();
const jwt = (owner: number) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: String(owner), exp: 4102444800 })).toString('base64url')}.test`;
let mockToken: string | null = jwt(1);
let mockReady = true;
jest.mock('@/api', () => ({
  habits: { getStory: (...args: [number, string?]) => mockGetStory(...args) },
}));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: mockToken,
    authStatus: 'authenticated',
    userTimezone: 'America/Los_Angeles',
    userTimezoneReady: mockReady,
  }),
}));
const { useHabitStory } = require('../useHabitStory');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const render = (habit: Habit | null, visible = true) =>
  renderHook(({ h, v }: { h: Habit | null; v: boolean }) => useHabitStory(h, v), {
    initialProps: { h: habit, v: visible },
  });

beforeEach(() => {
  setActiveUser(1);
  mockToken = jwt(1);
  mockReady = true;
  installSessionTokenGetter(() => mockToken);
  mockGetStory.mockReset().mockResolvedValue(habitStoryFixture());
});
afterEach(() => {
  installSessionTokenGetter(null);
  setActiveUser(null);
});

describe('useHabitStory', () => {
  it('reads the open habit with the pinned credential', async () => {
    const { result } = render(storyHabit());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.story?.continuity.current_run).toBe(7));
    expect(mockGetStory).toHaveBeenCalledWith(3, mockToken);
    expect(result.current.loading).toBe(false);
    expect(result.current.local).toBe(false);
  });

  it('asks for nothing while the sheet is closed or for a local row', () => {
    render(storyHabit(), false);
    const { result } = render(storyHabit({ isDemoSeed: true }));
    expect(mockGetStory).not.toHaveBeenCalled();
    expect(result.current.local).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it.each(['missing', 'mismatch', 'calendar', 'transition'])(
    'does not dispatch while %s is unresolved',
    (boundary) => {
      if (boundary === 'missing') mockToken = null;
      if (boundary === 'mismatch') mockToken = jwt(2);
      if (boundary === 'calendar') mockReady = false;
      if (boundary === 'transition') beginActiveUserTransition();
      render(storyHabit());
      expect(mockGetStory).not.toHaveBeenCalled();
    },
  );

  it('keeps the previous story dimmed while the same habit re-reads', async () => {
    const { result, rerender } = render(storyHabit());
    await waitFor(() => expect(result.current.story).not.toBeNull());
    const pending = deferred<ApiHabitStory>();
    mockGetStory.mockReturnValueOnce(pending.promise);
    rerender({ h: storyHabit(), v: false });
    rerender({ h: storyHabit(), v: true });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.story?.continuity.current_run).toBe(7);
    const later = habitStoryFixture();
    await act(async () =>
      pending.resolve({ ...later, continuity: { ...later.continuity, current_run: 8 } }),
    );
    expect(result.current.story?.continuity.current_run).toBe(8);
  });

  it('never shows one habit story under another', async () => {
    const { result, rerender } = render(storyHabit());
    await waitFor(() => expect(result.current.story).not.toBeNull());
    mockGetStory.mockReturnValueOnce(new Promise(() => undefined));
    rerender({ h: storyHabit({ id: 4 }), v: true });
    expect(result.current.story).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('drops a late answer across a new session and surfaces an error for retry', async () => {
    const pending = deferred<ApiHabitStory>();
    mockGetStory.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = render(storyHabit());
    act(() => {
      beginAuthSession();
      rerender({ h: storyHabit(), v: true });
    });
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    await act(async () => pending.resolve(habitStoryFixture()));
    expect(result.current.story).toBeNull();
    await act(async () => result.current.refresh());
    expect(result.current.story?.continuity.current_run).toBe(7);
    expect(result.current.error).toBeNull();
  });

  it('wraps a non-Error rejection', async () => {
    mockGetStory.mockRejectedValueOnce('nope');
    const { result } = render(storyHabit());
    await waitFor(() => expect(result.current.error?.message).toBe('nope'));
  });
});
