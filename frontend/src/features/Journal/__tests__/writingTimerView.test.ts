/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { DEFAULT_WRITING_MINUTES } from '../writingSession';
import { describeTimer, nextDurationMinutes, spokenDuration } from '../writingTimerView';

import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const IDLE_INPUT = {
  status: 'idle' as const,
  remainingMs: DEFAULT_WRITING_MINUTES * MS_PER_MINUTE,
  minutes: DEFAULT_WRITING_MINUTES,
};

describe('spokenDuration', () => {
  it('says whole minutes without a seconds part', () => {
    expect(spokenDuration(20 * MS_PER_MINUTE)).toBe('20 minutes');
  });

  it('speaks one minute in the singular', () => {
    expect(spokenDuration(MS_PER_MINUTE)).toBe('1 minute');
  });

  it('speaks minutes and seconds together when both are present', () => {
    expect(spokenDuration(MS_PER_MINUTE + 30_000)).toBe('1 minute 30 seconds');
  });

  it('speaks a sub-minute remainder as seconds alone, singular at one', () => {
    expect(spokenDuration(45_000)).toBe('45 seconds');
    expect(spokenDuration(1_000)).toBe('1 second');
  });

  it('speaks an exhausted countdown as zero seconds rather than an empty phrase', () => {
    expect(spokenDuration(0)).toBe('0 seconds');
  });
});

describe('describeTimer', () => {
  it('offers the set duration at rest: the full readout, the presets and Start only', () => {
    expect(describeTimer(IDLE_INPUT)).toEqual({
      readout: '20:00',
      readoutA11yLabel: '20 minutes left',
      showPresets: true,
      showStart: true,
      showPause: false,
      showResume: false,
      showStop: false,
    });
  });

  it('hides the presets while running and offers Pause and Stop', () => {
    expect(
      describeTimer({ status: 'running', remainingMs: 19 * MS_PER_MINUTE, minutes: 20 }),
    ).toEqual({
      readout: '19:00',
      readoutA11yLabel: '19 minutes left',
      showPresets: false,
      showStart: false,
      showPause: true,
      showResume: false,
      showStop: true,
    });
  });

  it('offers Resume and Stop while paused, still without the presets', () => {
    const view = describeTimer({ status: 'paused', remainingMs: 30_000, minutes: 20 });

    expect(view).toMatchObject({
      readout: '00:30',
      showPresets: false,
      showStart: false,
      showPause: false,
      showResume: true,
      showStop: true,
    });
  });

  it('offers no control at the moment a session completes', () => {
    expect(describeTimer({ status: 'complete', remainingMs: 0, minutes: 20 })).toMatchObject({
      readout: '00:00',
      showPresets: false,
      showStart: false,
      showPause: false,
      showResume: false,
      showStop: false,
    });
  });

  it('falls back to the set duration when the engine reports no countdown', () => {
    expect(describeTimer({ status: 'idle', remainingMs: null, minutes: 10 }).readout).toBe('10:00');
  });
});

describe('nextDurationMinutes', () => {
  it('takes the chosen length while the timer is at rest', () => {
    expect(nextDurationMinutes('idle', 20, 45)).toBe(45);
  });

  /**
   * The engine re-derives a running session's total from the live config on
   * every tick, so a length changed mid-session would silently retarget both
   * the countdown and the moment it completes. Refusing the change in code is
   * the guard; not rendering the presets is only the cover over it.
   */
  it('refuses the change once a session is under way, running or paused', () => {
    expect(nextDurationMinutes('running', 20, 45)).toBe(20);
    expect(nextDurationMinutes('paused', 20, 45)).toBe(20);
    expect(nextDurationMinutes('complete', 20, 45)).toBe(20);
  });
});
