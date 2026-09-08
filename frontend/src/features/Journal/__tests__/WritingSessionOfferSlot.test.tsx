/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import type { WritingSessionResult } from '../writingSession';
import { DEFAULT_WRITING_MINUTES } from '../writingSession';
import WritingSessionSurface from '../WritingSessionSurface';

import type { IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const TICK_MS = 100;
const T0 = 1_700_000_000_000;
const SHORT_PRESET_MINUTES = 10;

/** How many times an offer mounted in the slot has been created from scratch. */
let mounts = 0;
/** The result each rendered offer was handed. */
let lastResult: WritingSessionResult | null = null;

function Offer({ result }: { result: WritingSessionResult }): React.JSX.Element {
  React.useEffect(() => {
    mounts += 1;
  }, []);
  lastResult = result;
  return <Text testID="offer-probe">{`offer for ${result.elapsedMinutes}`}</Text>;
}

function renderSurface() {
  return render(
    <WritingSessionSurface
      renderOffer={(result) => <Offer result={result} />}
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
  mounts = 0;
  lastResult = null;
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the finished-session note carries whatever offer it is given', () => {
  it('holds nothing in the slot until a session has finished', () => {
    const { queryByTestId } = renderSurface();

    expect(queryByTestId('offer-probe')).toBeNull();
    expect(mounts).toBe(0);
  });

  it('mounts the offer inside the note, with the session it is about', () => {
    const { getByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getByTestId('offer-probe')).toBeTruthy();
    expect(lastResult?.elapsedMinutes).toBe(DEFAULT_WRITING_MINUTES);
    expect(mounts).toBe(1);
  });

  it('renders no offer at all when the surface is given none', () => {
    const { getByTestId, queryByTestId } = render(
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

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(queryByTestId('offer-probe')).toBeNull();
  });

  /**
   * The lifetime the banner's docstring promises: a session merely started,
   * or stopped early, reports nothing, so an offer halfway through an
   * interaction must survive it untouched.
   */
  it('leaves a standing offer mounted when the next session is abandoned', () => {
    const { getByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    expect(mounts).toBe(1);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(secondStart + 3 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(getByTestId('offer-probe')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  /**
   * The other half of that contract: a newer session REPLACES the note under a
   * slot that stays in the tree, so the offer has to be rebuilt or it would sit
   * beside a sentence about a different session holding the last one's state.
   */
  it('remounts the offer when a newer session replaces the note', () => {
    const { getByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId(`writing-timer-preset-${SHORT_PRESET_MINUTES}`));
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(secondStart + SHORT_PRESET_MINUTES * MS_PER_MINUTE);

    expect(mounts).toBe(2);
    expect(lastResult?.elapsedMinutes).toBe(SHORT_PRESET_MINUTES);
  });

  it('takes the offer away with the note the writer closed', () => {
    const { getByTestId, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-session-banner-dismiss'));

    expect(queryByTestId('offer-probe')).toBeNull();
  });
});
