/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { DEFAULT_WRITING_MINUTES } from '../writingSession';
import WritingSessionSurface from '../WritingSessionSurface';

import type { IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const TICK_MS = 100;
const T0 = 1_700_000_000_000;

function renderSurface() {
  return render(
    <WritingSessionSurface
      deps={{
        now: () => Date.now(),
        setIntervalMs: (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms),
        clearIntervalMs: (handle: IntervalHandle): void => {
          clearInterval(handle);
        },
      }}
    />,
  );
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
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WritingSessionSurface', () => {
  it('carries the timer and no note until a session has actually finished', () => {
    const { queryByTestId } = renderSurface();

    expect(queryByTestId('writing-timer-readout')).not.toBeNull();
    expect(queryByTestId('writing-session-banner')).toBeNull();
  });

  it('notes a session that ran its whole length', () => {
    const { getByTestId, getByText } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(getByText('You wrote for 20 minutes.')).toBeTruthy();
  });

  /**
   * Stopping is the writer saying they are done. Marking that with a note would
   * be the page remarking on a choice it was not asked about — the elapsed time
   * is still reported to whatever consumes the session, just not back at them.
   */
  it('says nothing at all about a session the writer stopped early', () => {
    const { getByTestId, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 12 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(queryByTestId('writing-session-banner')).toBeNull();
  });

  it('puts the note away in one tap and leaves the timer ready', () => {
    const { getByTestId, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-session-banner-dismiss'));

    expect(queryByTestId('writing-session-banner')).toBeNull();
    expect(getByTestId('writing-timer-readout').props.children).toBe('20:00');
    expect(queryByTestId('writing-timer-start')).not.toBeNull();
  });

  it('replaces an earlier note rather than stacking a second one', () => {
    const { getAllByTestId, getByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(secondStart + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getAllByTestId('writing-session-banner')).toHaveLength(1);
  });
});
