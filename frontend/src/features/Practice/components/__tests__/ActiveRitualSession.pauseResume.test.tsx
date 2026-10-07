/**
 * The completion window a sitting is saved with (#3072 AC1).
 *
 * `started_at` is the first start of the sitting, never the last resume, and
 * `ended_at - started_at` is the engine's active (pause-excluded) elapsed time,
 * capped at "now" so a backwards clock can never post a future timestamp.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeSessionCreate, PracticeSessionResponse, UserPractice } from '@/api';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import type { AudioAdapter, ModeConfig } from '@/features/Practice/engine/types';

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
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const TICK_MS = 100;

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const twentyMinuteTimer: ModeConfig = {
  mode: 'meditation_timer',
  duration_minutes: 20,
  halfway_bell: false,
};

const silentAudio: AudioAdapter = { play: () => undefined };

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
      audio={silentAudio}
    />,
  );
}

/** Move the wall clock, then let one engine tick observe it. */
function clockTo(ms: number): void {
  act(() => {
    jest.setSystemTime(ms);
    jest.advanceTimersByTime(TICK_MS);
  });
}

async function skipInsight(getByTestId: ReturnType<typeof render>['getByTestId']) {
  await act(async () => {
    fireEvent.press(getByTestId('insight-skip'));
  });
}

function postedWindow(): { started: number; ended: number } {
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const payload = mockCreate.mock.calls[0]?.[0];
  if (!payload) throw new Error('no payload posted');
  return { started: Date.parse(payload.started_at), ended: Date.parse(payload.ended_at) };
}

describe('ActiveRitualSession completion window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ id: 1 } as PracticeSessionResponse);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records the full sitting after pause and resume', async () => {
    const { getByTestId } = renderSession(twentyMinuteTimer);
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    clockTo(T0 + 15 * MIN);
    act(() => {
      fireEvent.press(getByTestId('ritual-pause'));
    });
    act(() => {
      jest.setSystemTime(T0 + 17 * MIN);
    });
    act(() => {
      fireEvent.press(getByTestId('ritual-resume'));
    });
    clockTo(T0 + 22 * MIN);
    expect(getByTestId('ritual-complete-label')).toBeTruthy();

    await skipInsight(getByTestId);

    const { started, ended } = postedWindow();
    expect(started).toBe(T0);
    expect(ended - started).toBe(20 * MIN);
    expect(ended).toBeLessThanOrEqual(Date.now());
  });

  it('never posts an ended_at later than now after a backwards clock jump', async () => {
    const { getByTestId } = renderSession({ mode: 'count_up' });
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    clockTo(T0 + 10 * MIN);
    // The device clock is corrected backwards; the engine's elapsed holds at
    // ten minutes, but the saved end must still not lie in the future.
    act(() => {
      jest.setSystemTime(T0 + 2 * MIN);
    });
    act(() => {
      fireEvent.press(getByTestId('count-up-end'));
    });

    await skipInsight(getByTestId);

    const { started, ended } = postedWindow();
    expect(started).toBe(T0);
    expect(ended).toBeLessThanOrEqual(Date.now());
    expect(ended).toBeGreaterThanOrEqual(started);
  });

  it('never posts an ended_at before started_at when the clock steps back past the start', async () => {
    const { getByTestId } = renderSession({ mode: 'count_up' });
    act(() => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    clockTo(T0 + 10 * MIN);
    // The clock steps back to five minutes *before* the sitting began: capping
    // the end at "now" alone would put it before the start. This pins only the
    // window's order (ended_at >= started_at). It does not show the save
    // succeeds: if the clock was fast when the start was stamped, that start is
    // still in the server's future and refused; re-anchoring it is out of scope.
    act(() => {
      jest.setSystemTime(T0 - 5 * MIN);
    });
    act(() => {
      fireEvent.press(getByTestId('count-up-end'));
    });

    await skipInsight(getByTestId);

    const { started, ended } = postedWindow();
    expect(started).toBe(T0);
    expect(ended).toBe(started);
  });
});
