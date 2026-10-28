/**
 * Clock-integrity invariants for the ritual reducer (#3072 AC2).
 *
 * The engine derives elapsed time from the wall clock, so it inherits every
 * quirk of that clock: a device that sleeps past the end of a sitting, a
 * backwards NTP correction, a pause recorded "after" its resume. Elapsed must
 * stay inside `[previous elapsed, planned total]` regardless.
 */
import { describe, expect, it } from '@jest/globals';

import { initialState, ritualReducer } from '../reducer';
import type { CountUpConfig, EngineAction, EngineState, MeditationTimerConfig } from '../types';

const MIN = 60_000;
const TEN_MINUTES_MS = 10 * MIN;

const timer: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 10,
  halfway_bell: false,
};

function drive(config: MeditationTimerConfig | CountUpConfig, actions: readonly EngineAction[]) {
  let state: EngineState = initialState(config);
  for (const action of actions) state = ritualReducer(state, action, config);
  return state;
}

describe('ritualReducer clock integrity', () => {
  it('backwards clock jump never yields negative elapsed', () => {
    const s = drive(timer, [
      { type: 'START', now: 1_000_000 },
      { type: 'TICK', now: 999_000 },
    ]);
    expect(s.elapsedMs).toBe(0);
    expect(s.remainingMs).toBe(TEN_MINUTES_MS);
  });

  it('completion after background is clamped to the planned duration', () => {
    const s = drive(timer, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 25 * MIN },
    ]);
    expect(s.status).toBe('complete');
    expect(s.elapsedMs).toBe(TEN_MINUTES_MS);
    expect(s.progress).toBe(1);
    expect(s.remainingMs).toBe(0);
  });

  it('COMPLETE freezes a clamped elapsed', () => {
    const s = drive(timer, [
      { type: 'START', now: 0 },
      { type: 'COMPLETE', now: 30 * MIN },
    ]);
    expect(s.status).toBe('complete');
    expect(s.elapsedMs).toBe(TEN_MINUTES_MS);
  });

  it('elapsed never decreases when the clock steps backwards mid-session', () => {
    const s = drive(timer, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 5 * MIN },
      { type: 'TICK', now: 4 * MIN },
    ]);
    expect(s.elapsedMs).toBe(5 * MIN);
    expect(s.remainingMs).toBe(5 * MIN);
  });

  it('resume with a backwards clock adds no negative pause time', () => {
    const s = drive(timer, [
      { type: 'START', now: 0 },
      { type: 'PAUSE', now: 5000 },
      { type: 'RESUME', now: 4000 },
      { type: 'TICK', now: 6000 },
    ]);
    expect(s.elapsedMs).toBe(6000);
  });

  it('an open-ended count_up is floored at zero but never capped', () => {
    const countUp: CountUpConfig = { mode: 'count_up' };
    const forward = drive(countUp, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 3 * 60 * MIN },
    ]);
    expect(forward.elapsedMs).toBe(3 * 60 * MIN);

    const backward = drive(countUp, [
      { type: 'START', now: 10_000 },
      { type: 'COMPLETE', now: 5000 },
    ]);
    expect(backward.elapsedMs).toBe(0);
  });
});
