/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import React from 'react';

import { useLinkedHabitCheckOff } from '../useLinkedHabitCheckOff';
import type { WritingSessionLaunch } from '../useQuickLaunchedSession';
import { useQuickLaunchedSession } from '../useQuickLaunchedSession';
import type { WritingSessionResult } from '../writingSession';
import WritingSessionSurface from '../WritingSessionSurface';

import type { PracticeSessionCreate, UiFlags } from '@/api';
import type { EngineDeps, IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const mockPracticeCreate = jest.fn<(_body: PracticeSessionCreate) => Promise<unknown>>();
const mockFlagsGet = jest.fn<(_token?: string) => Promise<UiFlags>>();
const mockCheckOff = jest.fn<(_request: Record<string, unknown>) => Promise<void>>();

jest.mock('@/api', () => ({
  practiceSessions: {
    create: (body: unknown) => mockPracticeCreate(body as PracticeSessionCreate),
  },
  uiFlags: { get: (token?: string) => mockFlagsGet(token), update: jest.fn() },
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'link-tok', userTimezone: 'America/Chicago' }),
}));

jest.mock('../writingHabitCheckOff', () => ({
  checkOffLinkedHabit: (request: Record<string, unknown>) => mockCheckOff(request),
}));

const LINKED_HABIT_ID = 42;
const TICK_MS = 100;
const T0 = 1_700_000_000_000;
const LAUNCH_MINUTES = 30;
const SELECTION_ID = 77;

const flags = (habitId: number | null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: habitId,
  practice_session_habit_id: null,
});

/** A fresh result object each time: the hook credits each finished session once. */
const finished = (): WritingSessionResult => ({
  plannedMinutes: 20,
  elapsedMs: 20 * MS_PER_MINUTE,
  elapsedMinutes: 20,
  reachedFullDuration: true,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  useWritingHabitLinkStore.getState().reset();
  mockFlagsGet.mockResolvedValue(flags(null));
  mockCheckOff.mockResolvedValue(undefined);
  mockPracticeCreate.mockResolvedValue({ id: 1 });
});

describe('useLinkedHabitCheckOff', () => {
  it('reads the link from the server on mount, with the session token', async () => {
    renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();

    expect(mockFlagsGet).toHaveBeenCalledWith('link-tok');
  });

  it('always hands the session to the handler it wraps', async () => {
    const inner = jest.fn();
    const { result } = renderHook(() => useLinkedHabitCheckOff(inner));
    await flush();
    const session = finished();

    act(() => result.current(session));

    expect(inner).toHaveBeenCalledWith(session);
  });

  it('with no link, checks nothing off', async () => {
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();

    act(() => result.current(finished()));

    expect(mockCheckOff).not.toHaveBeenCalled();
  });

  it('with a link, checks that habit off in the account zone, with the session’s minutes', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();
    const session = finished();

    act(() => result.current(session));

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      habitId: LINKED_HABIT_ID,
      elapsedMs: session.elapsedMs,
      elapsedMinutes: session.elapsedMinutes,
      tz: 'America/Chicago',
    });
  });

  it('the same finished session reported twice is credited once', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const inner = jest.fn();
    const { result } = renderHook(() => useLinkedHabitCheckOff(inner));
    await flush();
    const session = finished();

    act(() => result.current(session));
    act(() => result.current(session));

    expect(inner).toHaveBeenCalledTimes(2);
    expect(mockCheckOff).toHaveBeenCalledTimes(1);
  });

  it('two different sessions are each credited', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();

    act(() => result.current(finished()));
    act(() => result.current(finished()));

    expect(mockCheckOff).toHaveBeenCalledTimes(2);
  });
});

const deps: EngineDeps = {
  now: () => Date.now(),
  setIntervalMs: (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms),
  clearIntervalMs: (handle: IntervalHandle): void => {
    clearInterval(handle);
  },
};

/** The page as ``EntryWritingSurfaces`` assembles it: practice record, then check-off. */
function Page({ launch }: { launch?: WritingSessionLaunch }): React.JSX.Element {
  const session = useQuickLaunchedSession(launch);
  const onSession = useLinkedHabitCheckOff(session.onSession);
  return (
    <WritingSessionSurface
      initialMinutes={session.initialMinutes}
      autoStart={session.autoStart}
      onSession={onSession}
      deps={deps}
    />
  );
}

describe('useLinkedHabitCheckOff — composed with the page’s own session handler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a quick-launched page records the practice AND checks the habit off', async () => {
    render(<Page launch={{ minutes: LAUNCH_MINUTES, userPracticeId: SELECTION_ID }} />);
    await flush();

    jest.setSystemTime(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);
    act(() => {
      jest.advanceTimersByTime(TICK_MS);
    });

    expect(mockPracticeCreate).toHaveBeenCalledTimes(1);
    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      habitId: LINKED_HABIT_ID,
      elapsedMs: LAUNCH_MINUTES * MS_PER_MINUTE,
    });
  });

  it('an ordinary page stopped early still checks the habit off, and records no practice', async () => {
    const { getByTestId } = render(<Page />);
    await flush();

    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 5 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(mockPracticeCreate).not.toHaveBeenCalled();
    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({ elapsedMs: 5 * MS_PER_MINUTE });
  });
});
