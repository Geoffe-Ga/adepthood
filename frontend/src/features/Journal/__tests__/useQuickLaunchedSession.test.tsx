/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import type { WritingSessionLaunch } from '../useQuickLaunchedSession';
import { useQuickLaunchedSession } from '../useQuickLaunchedSession';
import WritingSessionSurface from '../WritingSessionSurface';

import type { PracticeSessionCreate } from '@/api';
import type { EngineDeps, IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const mockCreate = jest.fn<(_body: PracticeSessionCreate) => Promise<unknown>>();

jest.mock('@/api', () => ({
  practiceSessions: {
    create: (body: unknown) => mockCreate(body as PracticeSessionCreate),
  },
}));

/** Mirrors ``useRitualEngine``'s private TICK_INTERVAL_MS. */
const TICK_MS = 100;
const T0 = 1_700_000_000_000;
const SELECTION_ID = 77;
const LAUNCH_MINUTES = 30;

const deps: EngineDeps = {
  now: () => Date.now(),
  setIntervalMs: (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms),
  clearIntervalMs: (handle: IntervalHandle): void => {
    clearInterval(handle);
  },
};

/**
 * Stands in for the real "keep this as a practice" offer, so a page that put it
 * back can be told apart from one that rendered nothing at all.
 */
const renderStandInOffer = (): React.ReactNode => <Text testID="offer-stand-in">offer</Text>;

/**
 * The page as the screen assembles it: the hook decides what the surface is
 * given, and the surface drives the real engine. Asserting through the mounted
 * pair rather than the hook alone is what makes a callback the screen forgot to
 * pass on a failing test rather than an invisible one.
 */
function LaunchedPage({ launch }: { launch?: WritingSessionLaunch }): React.JSX.Element {
  const session = useQuickLaunchedSession(launch);
  return (
    <WritingSessionSurface
      initialMinutes={session.initialMinutes}
      autoStart={session.autoStart}
      onSession={session.onSession}
      renderOffer={session.launched ? undefined : renderStandInOffer}
      deps={deps}
    />
  );
}

/**
 * The length one recorded window covers.
 *
 * The pair of instants is what the server derives ``duration_minutes`` from, so
 * this is the number the practice actually counts. It is asserted rather than
 * the absolute instants because the report is made by the engine's first tick
 * PAST the end of the session, so the window is anchored wherever that tick
 * landed — exactly as ``WritingSessionOffer`` anchors its own.
 */
function windowMs(payload: PracticeSessionCreate): number {
  return Date.parse(payload.ended_at) - Date.parse(payload.started_at);
}

function tickTo(atMs: number): void {
  jest.setSystemTime(atMs);
  act(() => {
    jest.advanceTimersByTime(TICK_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: 1 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useQuickLaunchedSession — a page opened for nothing in particular', () => {
  it('leaves the timer waiting, at no length of its own', () => {
    const { getByTestId, queryByTestId } = render(<LaunchedPage />);

    expect(getByTestId('writing-timer-readout').props.children).toBe('20:00');
    expect(queryByTestId('writing-timer-stop')).toBeNull();
  });

  it('records nothing when a session finishes, and still offers to keep it', () => {
    const { getByTestId, queryByTestId } = render(<LaunchedPage />);

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + 20 * MS_PER_MINUTE);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(queryByTestId('offer-stand-in')).not.toBeNull();
  });
});

describe('useQuickLaunchedSession — a page opened to run a saved practice', () => {
  const launch: WritingSessionLaunch = {
    minutes: LAUNCH_MINUTES,
    userPracticeId: SELECTION_ID,
  };

  it('opens at the practice’s length, already running', () => {
    const { getByTestId, queryByTestId } = render(<LaunchedPage launch={launch} />);

    expect(getByTestId('writing-timer-readout').props.children).toBe('30:00');
    expect(queryByTestId('writing-timer-start')).toBeNull();
  });

  it('records the finished session against the selection it was launched from', () => {
    render(<LaunchedPage launch={launch} />);

    tickTo(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0]?.[0] as PracticeSessionCreate;
    expect(payload.user_practice_id).toBe(SELECTION_ID);
    expect(payload.completed).toBe(true);
    expect(windowMs(payload)).toBe(LAUNCH_MINUTES * MS_PER_MINUTE);
  });

  /**
   * A session stopped at twelve minutes of thirty is twelve minutes of writing,
   * and the record says twelve — not the thirty it was set to run.
   */
  it('records what was actually written when the writer stops early', () => {
    const { getByTestId } = render(<LaunchedPage launch={launch} />);

    jest.setSystemTime(T0 + 12 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(windowMs(mockCreate.mock.calls[0]?.[0] as PracticeSessionCreate)).toBe(
      12 * MS_PER_MINUTE,
    );
  });

  /**
   * A backgrounded device fires no tick, so the first tick after it wakes
   * observes the whole gap and every later tick observes a session already
   * over. One record, of the length the session was set to.
   */
  it('records once across a backgrounded gap, and never the hours the device slept', () => {
    render(<LaunchedPage launch={launch} />);

    tickTo(T0 + 3 * 60 * MS_PER_MINUTE);
    tickTo(T0 + 3 * 60 * MS_PER_MINUTE + TICK_MS);
    tickTo(T0 + 4 * 60 * MS_PER_MINUTE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Thirty minutes of writing, not the four hours the device was asleep.
    expect(windowMs(mockCreate.mock.calls[0]?.[0] as PracticeSessionCreate)).toBe(
      LAUNCH_MINUTES * MS_PER_MINUTE,
    );
  });

  /**
   * The writer answered "keep this as a practice" already — that is how the
   * practice exists to be launched from. Asking again on every page it opens
   * would be the nag the offer's one stored flag exists to prevent.
   */
  it('never re-asks whether to keep the session as a practice', () => {
    const { queryByTestId } = render(<LaunchedPage launch={launch} />);

    tickTo(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);

    expect(queryByTestId('writing-session-banner')).not.toBeNull();
    expect(queryByTestId('offer-stand-in')).toBeNull();
  });

  it('leaves the writing untouched when the record cannot be written', async () => {
    mockCreate.mockRejectedValue(new Error('offline'));
    const { getByTestId } = render(<LaunchedPage launch={launch} />);

    tickTo(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getByTestId('writing-session-banner')).toBeTruthy();
  });
});

describe('useQuickLaunchedSession — a practice whose stage is still ahead', () => {
  const waiting: WritingSessionLaunch = { minutes: LAUNCH_MINUTES, userPracticeId: null };

  /**
   * ``POST /practice-sessions/`` answers 403 ``stage_locked`` here, so the
   * request is never sent — the refusal is known before the writing starts,
   * and provoking it would turn a known state into an error.
   */
  it('writes the page but sends no session the server would refuse', () => {
    const { getByTestId } = render(<LaunchedPage launch={waiting} />);

    expect(getByTestId('writing-timer-readout').props.children).toBe('30:00');
    tickTo(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
