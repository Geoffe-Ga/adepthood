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
import { setActiveUser } from '@/storage/userScope';
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

// A signed-in writer: the check-off fences on the session lineage (#3452).
const mockLinkToken = `e30.${btoa(JSON.stringify({ sub: '1', exp: 4_000_000_000 })).replaceAll('=', '')}.sig`;
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: mockLinkToken,
    authStatus: 'authenticated',
    userTimezone: 'America/Chicago',
  }),
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
  course_last_stage: null,
  writing_session_habit_id: habitId,
});

const RESULT: WritingSessionResult = {
  plannedMinutes: 20,
  elapsedMs: 20 * MS_PER_MINUTE,
  elapsedMinutes: 20,
  reachedFullDuration: true,
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  setActiveUser(1);
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

    expect(mockFlagsGet).toHaveBeenCalledWith(mockLinkToken);
  });

  it('always hands the session to the handler it wraps', async () => {
    const inner = jest.fn();
    const { result } = renderHook(() => useLinkedHabitCheckOff(inner));
    await flush();

    act(() => result.current(RESULT));

    expect(inner).toHaveBeenCalledWith(RESULT);
  });

  it('with no link, checks nothing off', async () => {
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();

    act(() => result.current(RESULT));

    expect(mockCheckOff).not.toHaveBeenCalled();
  });

  it('with a link, checks that habit off in the account zone', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();

    act(() => result.current(RESULT));

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      habitId: LINKED_HABIT_ID,
      result: RESULT,
      tz: 'America/Chicago',
    });
  });

  it.each([false, true])(
    'keeps logging authority but delivers a held view notice only while mounted (unmount: %s)',
    async (leavePage) => {
      mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockCheckOff.mockImplementationOnce(async (request) => {
        await held;
        if ((request.isCurrent as () => boolean)())
          (request.onLogged as (_message: string) => void)('Logged 20 minutes to Journaling');
      });
      const onLogged = jest.fn();
      const screen = renderHook(() => useLinkedHabitCheckOff(jest.fn(), onLogged), {
        wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
      });
      await flush();
      act(() => screen.result.current(RESULT));
      const isCurrent = mockCheckOff.mock.calls[0]![0].isCurrent as () => boolean;
      if (leavePage) screen.unmount();
      expect(isCurrent()).toBe(true);
      await act(async () => {
        release();
        await held;
      });
      expect(mockCheckOff).toHaveBeenCalledTimes(1);
      expect(onLogged).toHaveBeenCalledTimes(leavePage ? 0 : 1);
      if (!leavePage)
        expect(onLogged).toHaveBeenCalledWith({
          result: RESULT,
          message: 'Logged 20 minutes to Journaling',
        });
    },
  );

  it('does not revive queued work when the link changes away and back', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();
    act(() => result.current(RESULT));
    const isCurrent = mockCheckOff.mock.calls[0]![0].isCurrent as () => boolean;
    expect(isCurrent()).toBe(true);
    act(() => {
      useWritingHabitLinkStore.setState({ habitId: 43 });
      useWritingHabitLinkStore.setState({ habitId: LINKED_HABIT_ID });
    });
    expect(isCurrent()).toBe(false);
  });

  it('does not dispatch an old render’s session after the account changes away and back', async () => {
    mockFlagsGet.mockResolvedValue(flags(LINKED_HABIT_ID));
    const { result } = renderHook(() => useLinkedHabitCheckOff(jest.fn()));
    await flush();
    const oldHandler = result.current;
    setActiveUser(2);
    setActiveUser(1);
    act(() => oldHandler(RESULT));
    expect(mockCheckOff).not.toHaveBeenCalled();
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
      result: expect.objectContaining({ elapsedMs: LAUNCH_MINUTES * MS_PER_MINUTE }),
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
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      result: expect.objectContaining({ elapsedMs: 5 * MS_PER_MINUTE }),
    });
  });
});
