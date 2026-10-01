/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { usePracticeHabitCheckOff } from '../usePracticeHabitCheckOff';

import type { PracticeSessionCreate, UiFlags } from '@/api';
import { usePracticeHabitLinkStore } from '@/store/usePracticeHabitLinkStore';

const mockFlagsGet = jest.fn<(_token?: string) => Promise<UiFlags>>();
const mockCheckOff = jest.fn<(_request: Record<string, unknown>) => Promise<void>>();

jest.mock('@/api', () => ({
  uiFlags: { get: (token?: string) => mockFlagsGet(token), update: jest.fn() },
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'practice-tok', userTimezone: 'America/Chicago' }),
}));

jest.mock('../../practiceHabitCheckOff', () => ({
  checkOffPracticeHabit: (request: Record<string, unknown>) => mockCheckOff(request),
  elapsedMinutesOf: () => 20,
}));

const LINKED_HABIT_ID = 42;

const flags = (habitId: number | null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: null,
  practice_session_habit_id: habitId,
});

/** A fresh payload each time: the hook credits each saved session once. */
const saved = (): PracticeSessionCreate => ({
  user_practice_id: 7,
  started_at: '2026-09-08T14:40:00.000Z',
  ended_at: '2026-09-08T15:00:00.000Z',
  completed: true,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  usePracticeHabitLinkStore.getState().reset();
  mockFlagsGet.mockResolvedValue(flags(null));
  mockCheckOff.mockResolvedValue(undefined);
});

describe('usePracticeHabitCheckOff', () => {
  it('reads the practice link from the server on mount, with the session token', async () => {
    renderHook(() => usePracticeHabitCheckOff());
    await flush();

    expect(mockFlagsGet).toHaveBeenCalledWith('practice-tok');
  });

  it('with no link, checks nothing off', async () => {
    const { result } = renderHook(() => usePracticeHabitCheckOff());
    await flush();

    act(() => result.current(saved()));

    expect(mockCheckOff).not.toHaveBeenCalled();
  });

  it('with a link, checks that habit off in the account zone, with the session’s minutes', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => usePracticeHabitCheckOff());
    await flush();

    act(() => result.current(saved()));

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      habitId: LINKED_HABIT_ID,
      elapsedMinutes: 20,
      tz: 'America/Chicago',
    });
  });

  it('reads the link at the moment the session is saved, not at render', async () => {
    const { result } = renderHook(() => usePracticeHabitCheckOff());
    await flush();
    usePracticeHabitLinkStore.setState({ habitId: LINKED_HABIT_ID, hydrated: true });

    act(() => result.current(saved()));

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
  });

  it('the same saved session handed over twice is credited once', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => usePracticeHabitCheckOff());
    await flush();
    const payload = saved();

    act(() => result.current(payload));
    act(() => result.current(payload));

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
  });

  it('two different sessions are each credited', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => usePracticeHabitCheckOff());
    await flush();

    act(() => result.current(saved()));
    act(() => result.current(saved()));

    expect(mockCheckOff).toHaveBeenCalledTimes(2);
  });

  it('keeps a stable identity across renders', async () => {
    const { result, rerender } = renderHook(() => usePracticeHabitCheckOff());
    await flush();
    const first = result.current;

    rerender(undefined);

    expect(result.current).toBe(first);
  });
});
