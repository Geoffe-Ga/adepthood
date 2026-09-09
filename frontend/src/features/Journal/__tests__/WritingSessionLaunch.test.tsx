/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { WritingSessionResult } from '../writingSession';
import { DEFAULT_WRITING_MINUTES } from '../writingSession';
import WritingSessionSurface from '../WritingSessionSurface';

import type { EngineDeps, IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

/** Mirrors ``useRitualEngine``'s private TICK_INTERVAL_MS. */
const TICK_MS = 100;
const T0 = 1_700_000_000_000;
/** A launch length that is deliberately none of the four presets. */
const LAUNCH_MINUTES = 35;

const deps: EngineDeps = {
  now: () => Date.now(),
  setIntervalMs: (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms),
  clearIntervalMs: (handle: IntervalHandle): void => {
    clearInterval(handle);
  },
};

function tickTo(atMs: number): void {
  jest.setSystemTime(atMs);
  act(() => {
    jest.advanceTimersByTime(TICK_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WritingSessionSurface — a session the page was opened to run', () => {
  it('opens at the length it was launched with and is already running', () => {
    const { getByTestId, queryByTestId } = render(
      <WritingSessionSurface autoStart initialMinutes={LAUNCH_MINUTES} deps={deps} />,
    );

    expect(getByTestId('writing-timer-readout').props.children).toBe('35:00');
    // Running, not waiting to be started: stop is offered and start is gone.
    expect(queryByTestId('writing-timer-start')).toBeNull();
    expect(queryByTestId('writing-timer-stop')).not.toBeNull();
  });

  it('waits for the writer when it was not launched', () => {
    const { getByTestId, queryByTestId } = render(
      <WritingSessionSurface initialMinutes={LAUNCH_MINUTES} deps={deps} />,
    );

    expect(getByTestId('writing-timer-start')).toBeTruthy();
    expect(queryByTestId('writing-timer-stop')).toBeNull();
  });

  it('runs the launched length rather than the writing page’s own default', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    render(
      <WritingSessionSurface
        autoStart
        initialMinutes={LAUNCH_MINUTES}
        onSession={onSession}
        deps={deps}
      />,
    );

    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    expect(onSession).not.toHaveBeenCalled();

    tickTo(T0 + LAUNCH_MINUTES * MS_PER_MINUTE);
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]?.[0].plannedMinutes).toBe(LAUNCH_MINUTES);
  });
});

describe('WritingSessionSurface — what every finished session is reported to', () => {
  it('reports a session that ran its whole length', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    render(
      <WritingSessionSurface autoStart initialMinutes={10} onSession={onSession} deps={deps} />,
    );

    tickTo(T0 + 10 * MS_PER_MINUTE);

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]?.[0]).toMatchObject({
      elapsedMs: 10 * MS_PER_MINUTE,
      reachedFullDuration: true,
    });
  });

  /**
   * The note only speaks for a session that ran its whole length, but the
   * elapsed time of one stopped early is still real writing — so the consumer
   * hears about it even though the page says nothing about it.
   */
  it('reports a session the writer stopped early, which the note stays silent about', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    const { getByTestId, queryByTestId } = render(
      <WritingSessionSurface autoStart initialMinutes={20} onSession={onSession} deps={deps} />,
    );

    jest.setSystemTime(T0 + 12 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(queryByTestId('writing-session-banner')).toBeNull();
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]?.[0]).toMatchObject({
      elapsedMs: 12 * MS_PER_MINUTE,
      reachedFullDuration: false,
    });
  });

  /**
   * A backgrounded app fires no tick, so the first tick after the device wakes
   * observes the entire gap at once — and every later tick observes a session
   * that is already complete. Exactly one report, and it reports the length the
   * session was set to rather than the hours the device was asleep.
   */
  it('reports once across a backgrounded gap, not once per tick after it', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    render(
      <WritingSessionSurface autoStart initialMinutes={20} onSession={onSession} deps={deps} />,
    );

    tickTo(T0 + 3 * 60 * MS_PER_MINUTE);
    tickTo(T0 + 3 * 60 * MS_PER_MINUTE + TICK_MS);
    tickTo(T0 + 4 * 60 * MS_PER_MINUTE);

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]?.[0].elapsedMs).toBe(20 * MS_PER_MINUTE);
  });
});
