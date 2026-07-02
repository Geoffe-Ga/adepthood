import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import React from 'react';

import type { UserPractice } from '@/api';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import type { MeditationTimerConfig } from '@/features/Practice/engine/types';

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const config: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 1,
  halfway_bell: true,
};

function renderSession() {
  return render(
    <ActiveRitualSession
      userPractice={userPractice}
      effectiveName="Breath Awareness"
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

describe('ActiveRitualSession haptics wiring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    (Haptics.impactAsync as jest.Mock).mockClear();
    (Haptics.notificationAsync as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires a light impact for the start_bell cue when the session starts', () => {
    const { getByTestId } = renderSession();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('fires a light impact for the halfway_bell cue at the midpoint', () => {
    const { getByTestId } = renderSession();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    (Haptics.impactAsync as jest.Mock).mockClear();

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('fires a success notification for the end_bell cue on completion', () => {
    const { getByTestId } = renderSession();

    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });
});
