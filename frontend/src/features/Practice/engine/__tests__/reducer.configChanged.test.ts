import { describe, expect, it } from '@jest/globals';

import { getTotalMs, initialState, ritualReducer } from '../reducer';
import type { EngineAction, MeditationTimerConfig } from '../types';
import { MS_PER_MINUTE } from '../types';

const MIN = MS_PER_MINUTE;

function drive(config: MeditationTimerConfig, actions: readonly EngineAction[]) {
  let state = initialState(config);
  for (const action of actions) state = ritualReducer(state, action, config);
  return state;
}

describe('ritualReducer — CONFIG_CHANGED', () => {
  it('re-seeds remainingMs on an idle session when getTotalMs changes', () => {
    const fiveMin: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
    const twentyMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 20,
    };

    const idle = initialState(fiveMin);
    expect(idle.status).toBe('idle');
    expect(idle.remainingMs).toBe(getTotalMs(fiveMin));

    // Dispatch CONFIG_CHANGED; pass the new config as the reducer's config arg.
    const next = ritualReducer(idle, { type: 'CONFIG_CHANGED' }, twentyMin);

    expect(next.status).toBe('idle');
    expect(next.remainingMs).toBe(getTotalMs(twentyMin));
    // Must equal exactly 20 * 60_000.
    expect(next.remainingMs).toBe(20 * MIN);
  });

  it('leaves a running session unchanged when CONFIG_CHANGED is dispatched', () => {
    const fiveMin: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
    const twentyMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 20,
    };

    // Build a running state the real way: start, then tick 30 s in.
    let running = drive(fiveMin, [{ type: 'START', now: 0 }]);
    running = ritualReducer(running, { type: 'TICK', now: 30_000 }, fiveMin);
    expect(running.status).toBe('running');
    const snapshotRemainingMs = running.remainingMs;
    const snapshotElapsedMs = running.elapsedMs;

    // Dispatch CONFIG_CHANGED; the running session must be returned unchanged.
    const after = ritualReducer(running, { type: 'CONFIG_CHANGED' }, twentyMin);

    expect(after.status).toBe('running');
    expect(after.remainingMs).toBe(snapshotRemainingMs);
    expect(after.elapsedMs).toBe(snapshotElapsedMs);
    // Referential equality: no new object should be produced.
    expect(after).toBe(running);
  });

  it('leaves a paused session unchanged when CONFIG_CHANGED is dispatched', () => {
    const fiveMin: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
    const twentyMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 20,
    };

    // Build a paused state via real reducer transitions.
    let paused = drive(fiveMin, [{ type: 'START', now: 0 }]);
    paused = ritualReducer(paused, { type: 'TICK', now: 15_000 }, fiveMin);
    paused = ritualReducer(paused, { type: 'PAUSE', now: 15_000 }, fiveMin);
    expect(paused.status).toBe('paused');

    // Dispatch CONFIG_CHANGED; the paused session must be returned by reference.
    const after = ritualReducer(paused, { type: 'CONFIG_CHANGED' }, twentyMin);

    expect(after.status).toBe('paused');
    expect(after).toBe(paused);
  });
});
