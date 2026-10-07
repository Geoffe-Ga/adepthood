/**
 * When the bells cannot play (the audio player fails to construct, or the
 * browser refuses a play — blocked web autoplay), the session says so without blocking:
 * the timer still runs, completes and saves (#3072 AC10). The metronome's
 * deliberate silence is not a failure and must not raise the notice.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createAudioPlayer } from 'expo-audio';
import React from 'react';
import { Platform } from 'react-native';

import type { PracticeSessionCreate, PracticeSessionResponse, UserPractice } from '@/api';
import ActiveRitualSession, {
  BELLS_UNAVAILABLE_COPY,
} from '@/features/Practice/components/ActiveRitualSession';
import type { ModeConfig } from '@/features/Practice/engine/types';

const mockCreate = jest.fn<(payload: PracticeSessionCreate) => Promise<PracticeSessionResponse>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    practiceSessions: {
      create: (payload: PracticeSessionCreate) => mockCreate(payload),
    },
  };
});

const MIN = 60_000;
const TICK_MS = 100;

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

function renderSession(config: ModeConfig) {
  return render(
    <ActiveRitualSession
      userPractice={userPractice}
      effectiveName="Sitting"
      effectiveConfig={config}
      userTimezone="UTC"
      onSessionApply={jest.fn()}
      onSessionRollback={jest.fn()}
      onSessionCommitted={jest.fn()}
      onUserPracticeUpdated={jest.fn()}
      onWriteReflection={jest.fn()}
    />,
  );
}

/**
 * A player shaped like expo-audio's web `AudioPlayerWeb`: `play()` returns
 * void and drops the media element's `play()` promise, and `seekTo` only
 * assigns `currentTime`, so neither ever rejects. A blocked autoplay surfaces
 * only as the element staying `paused` after `play()` (the HTML algorithm
 * refuses before it clears `paused`).
 */
function webPlayer(allowed: boolean) {
  const sound = {
    paused: true,
    seekTo: () => Promise.resolve(),
    play: (): void => {
      if (allowed) sound.paused = false;
    },
    remove: () => undefined,
  };
  return sound;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ActiveRitualSession bells-unavailable notice', () => {
  const player = createAudioPlayer as jest.Mock;
  const originalOS = Platform.OS;
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ id: 1 } as PracticeSessionResponse);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Platform.OS = originalOS;
    player.mockReset();
    warn.mockRestore();
    jest.useRealTimers();
  });

  it('shows the notice when the audio player cannot be built, and the session still saves', async () => {
    player.mockImplementation(() => {
      throw new Error('audio blocked');
    });
    const { getByTestId } = renderSession({ mode: 'meditation_timer', duration_minutes: 1 });
    await flushMicrotasks();

    expect(getByTestId('ritual-bells-unavailable')).toHaveTextContent(BELLS_UNAVAILABLE_COPY);

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    act(() => {
      jest.setSystemTime(MIN);
      jest.advanceTimersByTime(TICK_MS);
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-skip'));
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the notice when the browser refuses to play a bell', async () => {
    Platform.OS = 'web';
    player.mockImplementation(() => webPlayer(false));
    const { getByTestId, queryByTestId } = renderSession({
      mode: 'meditation_timer',
      duration_minutes: 1,
    });
    await flushMicrotasks();
    expect(queryByTestId('ritual-bells-unavailable')).toBeNull();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(getByTestId('ritual-bells-unavailable')).toBeTruthy();
  });

  it('stays quiet when the browser plays the bell', async () => {
    Platform.OS = 'web';
    player.mockImplementation(() => webPlayer(true));
    const { getByTestId, queryByTestId } = renderSession({
      mode: 'meditation_timer',
      duration_minutes: 1,
    });
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(queryByTestId('ritual-bells-unavailable')).toBeNull();
  });

  it('does not read a native player still settling as a refusal', async () => {
    // Native players flip `paused` asynchronously, so a just-started native
    // bell can still read paused; only the web element answers synchronously.
    Platform.OS = 'ios';
    player.mockImplementation(() => webPlayer(false));
    const { getByTestId, queryByTestId } = renderSession({
      mode: 'meditation_timer',
      duration_minutes: 1,
    });
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(queryByTestId('ritual-bells-unavailable')).toBeNull();
  });

  it('shows the notice when a random-interval bell is refused', async () => {
    // This mode's bells are played by its view, not the engine (which
    // schedules none), so the view must play through the session's adapter.
    Platform.OS = 'web';
    player.mockImplementation(() => webPlayer(false));
    const { getByTestId, queryByTestId } = renderSession({
      mode: 'random_interval_bell',
      duration_minutes: 1,
      min_interval_seconds: 10,
      max_interval_seconds: 20,
      bell_tone: 'bowl',
    });
    await flushMicrotasks();
    expect(queryByTestId('ritual-bells-unavailable')).toBeNull();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(getByTestId('ritual-bells-unavailable')).toBeTruthy();
  });

  it('a working player on a metronome leaves the notice absent (its silence is by design)', async () => {
    player.mockImplementation(() => ({
      seekTo: () => Promise.resolve(),
      play: () => undefined,
      remove: () => undefined,
    }));
    const { getByTestId, queryByTestId } = renderSession({
      mode: 'metronome',
      bpm: 60,
      timer: { mode: 'meditation_timer', duration_minutes: 1 },
    });
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    act(() => {
      jest.setSystemTime(5000);
      jest.advanceTimersByTime(TICK_MS);
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(queryByTestId('ritual-bells-unavailable')).toBeNull();
  });
});
