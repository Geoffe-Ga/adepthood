import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Audio } from 'expo-av';
import React from 'react';

import type { UserPractice } from '@/api';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import type {
  AudioAdapter,
  MeditationTimerConfig,
  ModeConfig,
  RandomIntervalBellConfig,
} from '@/features/Practice/engine/types';

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const meditationConfig: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 1,
  halfway_bell: true,
};

const randomBellConfig: RandomIntervalBellConfig = {
  mode: 'random_interval_bell',
  duration_minutes: 1,
  min_interval_seconds: 5,
  max_interval_seconds: 10,
  bell_tone: 'bowl',
};

function createAudioSpy(): AudioAdapter {
  return {
    play: jest.fn<AudioAdapter['play']>(),
    dispose: jest.fn<NonNullable<AudioAdapter['dispose']>>(),
  };
}

interface RenderOverrides {
  config?: ModeConfig;
  audio?: AudioAdapter;
}

function renderSession(overrides: RenderOverrides = {}) {
  return render(
    <ActiveRitualSession
      userPractice={userPractice}
      effectiveName="Breath Awareness"
      effectiveConfig={overrides.config ?? meditationConfig}
      userTimezone="UTC"
      onSessionApply={jest.fn()}
      onSessionRollback={jest.fn()}
      onSessionCommitted={jest.fn()}
      onUserPracticeUpdated={jest.fn()}
      onWriteReflection={jest.fn()}
      audio={overrides.audio}
    />,
  );
}

describe('ActiveRitualSession audio wiring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    (Audio.Sound.createAsync as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('plays the start_bell cue through the injected audio adapter when the session starts', () => {
    const spy = createAudioSpy();
    const { getByTestId } = renderSession({ audio: spy });

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    expect(spy.play).toHaveBeenCalledWith('start_bell');
  });

  it('plays the halfway_bell then the end_bell exactly once each as the session progresses', () => {
    const spy = createAudioSpy();
    const { getByTestId } = renderSession({ audio: spy });

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    const halfwayCalls = (spy.play as jest.Mock).mock.calls.filter(
      ([kind]) => kind === 'halfway_bell',
    );
    expect(halfwayCalls).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    const endCalls = (spy.play as jest.Mock).mock.calls.filter(([kind]) => kind === 'end_bell');
    expect(endCalls).toHaveLength(1);
    expect(
      (spy.play as jest.Mock).mock.calls.filter(([kind]) => kind === 'halfway_bell'),
    ).toHaveLength(1);
  });

  it('falls back to the expo-av-backed adapter when no audio prop is given', () => {
    const { getByTestId } = renderSession();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    expect(Audio.Sound.createAsync).toHaveBeenCalled();
  });

  it('disposes the injected audio adapter exactly once on unmount', () => {
    const spy = createAudioSpy();
    const { unmount, getByTestId } = renderSession({ audio: spy });

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    act(() => {
      unmount();
    });

    expect(spy.dispose).toHaveBeenCalledTimes(1);
  });

  it('never calls the injected engine audio adapter for random_interval_bell (view owns its own bells)', () => {
    const spy = createAudioSpy();
    const { getByTestId } = renderSession({ config: randomBellConfig, audio: spy });

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(spy.play).not.toHaveBeenCalled();
  });
});
