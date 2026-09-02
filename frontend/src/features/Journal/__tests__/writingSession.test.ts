/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { DEFAULT_WRITING_MINUTES, toWritingSessionResult } from '../writingSession';

import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

describe('toWritingSessionResult', () => {
  it('reports a stop at 19:59 of a twenty-minute session as twenty elapsed minutes that did not reach the full duration', () => {
    const elapsedMs = 19 * MS_PER_MINUTE + 59_000;

    expect(toWritingSessionResult({ plannedMinutes: DEFAULT_WRITING_MINUTES, elapsedMs })).toEqual({
      plannedMinutes: 20,
      elapsedMs,
      elapsedMinutes: 20,
      reachedFullDuration: false,
    });
  });

  it('reports a session run to the full twenty minutes as having reached it', () => {
    const elapsedMs = 20 * MS_PER_MINUTE;

    expect(toWritingSessionResult({ plannedMinutes: DEFAULT_WRITING_MINUTES, elapsedMs })).toEqual({
      plannedMinutes: 20,
      elapsedMs,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    });
  });
});

describe('toWritingSessionResult — time the writer did not spend writing', () => {
  /**
   * The engine derives elapsed from the wall clock and a backgrounded app fires
   * no tick, so the first tick after the device wakes observes the whole gap.
   * A session cannot have run longer than the length it was set to, so the
   * reported duration is bounded by it.
   */
  it('bounds a session the device slept through to the length it was set to', () => {
    expect(
      toWritingSessionResult({
        plannedMinutes: DEFAULT_WRITING_MINUTES,
        elapsedMs: 3 * 60 * MS_PER_MINUTE,
      }),
    ).toEqual({
      plannedMinutes: 20,
      elapsedMs: 20 * MS_PER_MINUTE,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    });
  });

  it('still reports reaching the full duration honestly, since the clock did pass it', () => {
    const slept = toWritingSessionResult({ plannedMinutes: 10, elapsedMs: 47 * MS_PER_MINUTE });

    expect(slept.reachedFullDuration).toBe(true);
    expect(slept.elapsedMs).toBe(10 * MS_PER_MINUTE);
  });

  it('floors a negative elapsed at zero rather than reporting time owed', () => {
    expect(toWritingSessionResult({ plannedMinutes: 20, elapsedMs: -5_000 })).toEqual({
      plannedMinutes: 20,
      elapsedMs: 0,
      elapsedMinutes: 0,
      reachedFullDuration: false,
    });
  });
});
