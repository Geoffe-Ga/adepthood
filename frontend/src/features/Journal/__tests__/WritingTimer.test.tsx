/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { DEFAULT_WRITING_MINUTES } from '../writingSession';
import type { WritingSessionResult } from '../writingSession';
import WritingTimer from '../WritingTimer';

import type {
  CueKind,
  EngineDeps,
  IntervalBellTone,
  IntervalHandle,
} from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

/**
 * Mirrors ``useRitualEngine``'s own TICK_INTERVAL_MS, which the module keeps
 * private. Every drive below jumps the system clock to the moment it cares
 * about and then advances the timer clock by exactly one tick, rather than
 * running twelve thousand real intervals: the reducer derives elapsed as
 * ``now - startedAtMs - pausedTotalMs`` instead of accumulating per tick, so a
 * single late tick observes the whole jump. If that ever changes, these specs
 * get slow rather than red — which is why it is written down here.
 */
const TICK_MS = 100;
const T0 = 1_700_000_000_000;

type SetIntervalFn = (cb: () => void, ms: number) => IntervalHandle;
type ClearIntervalFn = (handle: IntervalHandle) => void;
type PlayFn = (kind: CueKind, tone?: IntervalBellTone) => void;
type CueFn = (kind: CueKind) => void;

function makeDeps() {
  const setIntervalMs = jest.fn<SetIntervalFn>((cb, ms) => setInterval(cb, ms));
  const clearIntervalMs = jest.fn<ClearIntervalFn>((handle) => {
    clearInterval(handle);
  });
  const play = jest.fn<PlayFn>();
  const cue = jest.fn<CueFn>();
  const deps: EngineDeps = {
    now: () => Date.now(),
    setIntervalMs,
    clearIntervalMs,
    audio: { play },
    haptics: { cue },
  };
  return { deps, setIntervalMs, clearIntervalMs, play, cue };
}

/** Jump the wall clock to `atMs`, then let exactly one engine tick observe it. */
function tickTo(atMs: number): void {
  jest.setSystemTime(atMs);
  act(() => {
    jest.advanceTimersByTime(TICK_MS);
  });
}

function renderTimer(onComplete: (result: WritingSessionResult) => void, initialMinutes?: number) {
  const harness = makeDeps();
  const view = render(
    <WritingTimer onComplete={onComplete} deps={harness.deps} initialMinutes={initialMinutes} />,
  );
  return { ...harness, ...view };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WritingTimer — the offer at rest', () => {
  it('shows the set duration rather than an empty clock, and offers only Start', () => {
    const { getByTestId, queryByTestId } = renderTimer(jest.fn());

    expect(getByTestId('writing-timer-readout').props.children).toBe('20:00');
    expect(queryByTestId('writing-timer-start')).not.toBeNull();
    expect(queryByTestId('writing-timer-pause')).toBeNull();
    expect(queryByTestId('writing-timer-stop')).toBeNull();
  });

  it('never announces the ticking readout, which would speak over the writing', () => {
    const { getByTestId } = renderTimer(jest.fn());

    expect(getByTestId('writing-timer-readout').props.accessibilityLiveRegion).toBeUndefined();
  });

  it('re-seeds the countdown in place when another length is chosen', () => {
    const { getByTestId } = renderTimer(jest.fn());

    fireEvent.press(getByTestId('writing-timer-preset-45'));

    expect(getByTestId('writing-timer-readout').props.children).toBe('45:00');
    expect(getByTestId('writing-timer-preset-45').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('writing-timer-preset-20').props.accessibilityState.selected).toBe(false);
  });
});

describe('WritingTimer — a session that runs its length', () => {
  it('counts down from a single engine interval and reports the finished session once', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId, setIntervalMs } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    expect(setIntervalMs).toHaveBeenCalledTimes(1);
    expect(setIntervalMs).toHaveBeenCalledWith(expect.any(Function), TICK_MS);

    tickTo(T0 + 5 * MS_PER_MINUTE);
    expect(getByTestId('writing-timer-readout').props.children).toBe('14:59');
    expect(onComplete).not.toHaveBeenCalled();

    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toMatchObject({
      plannedMinutes: 20,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    });
    // One interval for the whole session, and it was released on completion.
    expect(setIntervalMs).toHaveBeenCalledTimes(1);
  });

  it('strikes no bell and buzzes nothing across a whole session', () => {
    const { getByTestId, play, cue } = renderTimer(jest.fn());

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(play).not.toHaveBeenCalled();
    expect(cue).not.toHaveBeenCalled();
  });

  it('returns to the offer once the session is reported, ready but not started', () => {
    const { getByTestId, queryByTestId } = renderTimer(jest.fn());

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getByTestId('writing-timer-readout').props.children).toBe('20:00');
    expect(queryByTestId('writing-timer-start')).not.toBeNull();
    expect(queryByTestId('writing-timer-stop')).toBeNull();
  });
});

describe('WritingTimer — a session the writer stops', () => {
  it('keeps the time already written rather than discarding it', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 19 * MS_PER_MINUTE + 59_000);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toEqual({
      plannedMinutes: 20,
      elapsedMs: 19 * MS_PER_MINUTE + 59_000,
      elapsedMinutes: 20,
      reachedFullDuration: false,
    });
  });

  it('reports a stop from a pause without the time spent away from the page', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + 3 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-pause'));

    jest.setSystemTime(T0 + 33 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(onComplete.mock.calls[0]![0]!.elapsedMinutes).toBe(3);
    expect(onComplete.mock.calls[0]![0]!.reachedFullDuration).toBe(false);
  });

  it('resumes where it paused rather than where the clock got to', () => {
    const { getByTestId } = renderTimer(jest.fn());

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + 3 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-pause'));
    jest.setSystemTime(T0 + 33 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-resume'));

    tickTo(T0 + 34 * MS_PER_MINUTE);

    expect(getByTestId('writing-timer-readout').props.children).toBe('15:59');
  });
});

describe('WritingTimer — two sessions in one mount', () => {
  it('reports each on its own terms, with no verdict carried over from the first', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 4 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(onComplete.mock.calls[0]![0]!.reachedFullDuration).toBe(false);

    const secondStart = T0 + 5 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(secondStart + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete.mock.calls[1]![0]!.reachedFullDuration).toBe(true);
  });
});

describe('WritingTimer — the length is only settable at rest', () => {
  it('presents no length to change once a session is under way', () => {
    const { getByTestId, queryByTestId } = renderTimer(jest.fn());

    fireEvent.press(getByTestId('writing-timer-start'));

    expect(queryByTestId('writing-timer-row-presets')).toBeNull();
    expect(queryByTestId('writing-timer-preset-45')).toBeNull();
  });
});

describe('WritingTimer — leaving the page', () => {
  it('releases the ticker on unmount and stops reporting anything', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId, unmount, clearIntervalMs } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + MS_PER_MINUTE);
    expect(clearIntervalMs).not.toHaveBeenCalled();

    unmount();
    expect(clearIntervalMs).toHaveBeenCalledTimes(1);

    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('WritingTimer — reachable by a screen reader', () => {
  it('names every control and says which length is chosen', () => {
    const { getByTestId } = renderTimer(jest.fn());

    expect(getByTestId('writing-timer-start').props.accessibilityLabel).toBe(
      'Start the writing timer',
    );
    expect(getByTestId('writing-timer-preset-30').props.accessibilityLabel).toBe(
      'Write for 30 minutes',
    );
    expect(getByTestId('writing-timer-preset-20').props.accessibilityState.selected).toBe(true);

    fireEvent.press(getByTestId('writing-timer-start'));
    expect(getByTestId('writing-timer-stop').props.accessibilityLabel).toBe(
      'Stop the writing timer and keep the time so far',
    );
  });

  it('opens at a length the caller names, for a page that arrives with one in mind', () => {
    const { getByTestId } = renderTimer(jest.fn(), 10);

    expect(getByTestId('writing-timer-readout').props.children).toBe('10:00');
  });
});

describe('WritingTimer — a session the device slept through', () => {
  /**
   * The engine derives elapsed from the wall clock, and a backgrounded app
   * fires no interval. The first tick after the writer returns therefore
   * observes the whole gap at once, so a twenty-minute session can land its
   * completion holding hours of "elapsed" time that nobody spent writing.
   */
  it('never reports more time than the session was set to run for', () => {
    const onComplete = jest.fn<(result: WritingSessionResult) => void>();
    const { getByTestId } = renderTimer(onComplete);

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + 3 * 60 * MS_PER_MINUTE);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toEqual({
      plannedMinutes: 20,
      elapsedMs: 20 * MS_PER_MINUTE,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    });
  });
});
