import { describe, expect, it } from '@jest/globals';

import { initialState, ritualReducer } from '../reducer';
import type {
  CountUpConfig,
  EngineAction,
  EngineState,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  RepCounterConfig,
  SenseGroundingConfig,
  TarotConfig,
} from '../types';

const MIN = 60_000;

function drive(
  config: ModeConfig,
  actions: readonly EngineAction[],
  startCardIndex = 0,
): EngineState {
  let state = initialState(config, startCardIndex);
  for (const action of actions) state = ritualReducer(state, action, config);
  return state;
}

describe('ritualReducer — meditation_timer', () => {
  const config: MeditationTimerConfig = {
    mode: 'meditation_timer',
    duration_minutes: 10,
    halfway_bell: true,
  };

  it('strikes start at 0, halfway at 5min, end at 10min, then completes', () => {
    let s = drive(config, [{ type: 'START', now: 0 }]);
    expect(s.cuesStruck).toBe(1);
    expect(s.nextCueAtMs).toBe(5 * MIN);

    s = ritualReducer(s, { type: 'TICK', now: 5 * MIN }, config);
    expect(s.cuesStruck).toBe(2);
    expect(s.progress).toBeCloseTo(0.5);
    expect(s.remainingMs).toBe(5 * MIN);

    s = ritualReducer(s, { type: 'TICK', now: 10 * MIN }, config);
    expect(s.cuesStruck).toBe(3);
    expect(s.status).toBe('complete');
    expect(s.remainingMs).toBe(0);
  });

  it('skips halfway when halfway_bell is false', () => {
    const s = drive({ ...config, halfway_bell: false }, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 5 * MIN },
    ]);
    expect(s.cuesStruck).toBe(1);
    expect(s.nextCueAtMs).toBe(10 * MIN);
  });
});

describe('ritualReducer — count_up', () => {
  const config: CountUpConfig = { mode: 'count_up' };

  it('never auto-completes; progress stays 0; remaining is null', () => {
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 60 * MIN },
    ]);
    expect(s.status).toBe('running');
    expect(s.progress).toBe(0);
    expect(s.remainingMs).toBeNull();
    expect(s.elapsedMs).toBe(60 * MIN);
  });

  it('complete() freezes elapsedMs and transitions to complete', () => {
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 7 * MIN },
      { type: 'COMPLETE', now: 7 * MIN },
    ]);
    expect(s.status).toBe('complete');
    expect(s.elapsedMs).toBe(7 * MIN);
  });
});

describe('ritualReducer — metronome', () => {
  it('strikes 600 ticks across 10 minutes alongside embedded timer cues', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: 60,
      timer: { mode: 'meditation_timer', duration_minutes: 10, halfway_bell: true },
    };
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 10 * MIN },
    ]);
    // 600 metronome ticks + start + halfway + end
    expect(s.cuesStruck).toBe(603);
    expect(s.status).toBe('complete');
  });
});

describe('ritualReducer — interval_bell', () => {
  it('fires 4 interval cues + start + end for interval_minutes=5 over 20 minutes', () => {
    const config: IntervalBellConfig = {
      mode: 'interval_bell',
      duration_minutes: 20,
      interval_minutes: 5,
      bell_tone: 'bowl',
    };
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 20 * MIN },
    ]);
    expect(s.cuesStruck).toBe(6);
    expect(s.status).toBe('complete');
  });

  it('honours cue_offsets_minutes verbatim', () => {
    const config: IntervalBellConfig = {
      mode: 'interval_bell',
      duration_minutes: 15,
      cue_offsets_minutes: [3, 7, 12],
      bell_tone: 'chime',
    };
    let s = drive(config, [{ type: 'START', now: 0 }]);
    expect(s.cuesStruck).toBe(1);
    s = ritualReducer(s, { type: 'TICK', now: 12 * MIN }, config);
    expect(s.cuesStruck).toBe(4);
    s = ritualReducer(s, { type: 'TICK', now: 15 * MIN }, config);
    expect(s.cuesStruck).toBe(5);
    expect(s.status).toBe('complete');
  });
});

describe('ritualReducer — rep_counter', () => {
  const config: RepCounterConfig = {
    mode: 'rep_counter',
    target_reps: 3,
    unit_label: 'breaths',
  };

  it('increments repCount on TAP and auto-completes at target_reps', () => {
    let s = drive(config, [{ type: 'START', now: 0 }, { type: 'TAP' }, { type: 'TAP' }]);
    expect(s.repCount).toBe(2);
    expect(s.progress).toBeCloseTo(2 / 3);
    s = ritualReducer(s, { type: 'TAP' }, config);
    expect(s.status).toBe('complete');
  });

  it('completes via time cap when time_cap_minutes elapses first', () => {
    const s = drive({ ...config, time_cap_minutes: 2 }, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 2 * MIN },
    ]);
    expect(s.status).toBe('complete');
  });
});

describe('ritualReducer — sense_grounding', () => {
  const config: SenseGroundingConfig = {
    mode: 'sense_grounding',
    prompts: [
      { sense: 'sight', label: 'a tree' },
      { sense: 'touch', label: 'fabric' },
      { sense: 'hearing', label: 'a sound' },
    ],
  };

  it('TAP advances currentStepIndex through every prompt then auto-completes', () => {
    let s = drive(config, [{ type: 'START', now: 0 }, { type: 'TAP' }, { type: 'TAP' }]);
    expect(s.currentStepIndex).toBe(2);
    expect(s.progress).toBeCloseTo(2 / 3);
    s = ritualReducer(s, { type: 'TAP' }, config);
    expect(s.currentStepIndex).toBe(3);
    expect(s.status).toBe('complete');
  });

  it('ADVANCE_STEP behaves like TAP', () => {
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'ADVANCE_STEP' },
      { type: 'ADVANCE_STEP' },
    ]);
    expect(s.currentStepIndex).toBe(2);
  });

  it('with zero prompts: progress stays 0 and TAP completes immediately', () => {
    const empty: SenseGroundingConfig = { mode: 'sense_grounding', prompts: [] };
    let s = drive(empty, [{ type: 'START', now: 0 }]);
    expect(s.progress).toBe(0);
    s = ritualReducer(s, { type: 'TAP' }, empty);
    expect(s.status).toBe('complete');
    expect(s.progress).toBe(0);
  });
});

describe('ritualReducer — tarot', () => {
  const config: TarotConfig = { mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 };

  it('preserves the start card index and emits end cue at per_card_minutes', () => {
    let s = drive(config, [{ type: 'START', now: 0 }], 7);
    expect(s.currentStepIndex).toBe(7);
    expect(s.cuesStruck).toBe(0);
    s = ritualReducer(s, { type: 'TICK', now: 5 * MIN }, config);
    expect(s.cuesStruck).toBe(1);
    expect(s.status).toBe('complete');
  });

  it('ADVANCE_STEP cycles modulo the deck size', () => {
    const s = drive(
      config,
      [
        { type: 'START', now: 0 },
        ...Array.from({ length: 22 }, (): EngineAction => ({ type: 'ADVANCE_STEP' })),
      ],
      5,
    );
    expect(s.currentStepIndex).toBe(5);
  });

  it('defaults per_card_minutes to 5 when omitted', () => {
    const t: TarotConfig = { mode: 'tarot', deck: 'major_arcana' };
    const s = drive(t, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 5 * MIN },
    ]);
    expect(s.status).toBe('complete');
  });
});

const allConfigs: readonly [string, ModeConfig][] = [
  ['meditation_timer', { mode: 'meditation_timer', duration_minutes: 10 }],
  ['count_up', { mode: 'count_up' }],
  [
    'metronome',
    { mode: 'metronome', bpm: 60, timer: { mode: 'meditation_timer', duration_minutes: 10 } },
  ],
  [
    'interval_bell',
    { mode: 'interval_bell', duration_minutes: 10, interval_minutes: 5, bell_tone: 'bowl' },
  ],
  ['rep_counter', { mode: 'rep_counter', target_reps: 5, unit_label: 'reps' }],
  ['sense_grounding', { mode: 'sense_grounding', prompts: [{ sense: 'sight', label: 'a tree' }] }],
  ['tarot', { mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 }],
];

describe.each(allConfigs)('lifecycle — %s', (_mode, config) => {
  it('pause/resume preserves elapsedMs without leaking pause time', () => {
    let s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 60_000 },
      { type: 'PAUSE', now: 60_000 },
    ]);
    s = ritualReducer(s, { type: 'RESUME', now: 90_000 }, config);
    s = ritualReducer(s, { type: 'TICK', now: 120_000 }, config);
    expect(s.elapsedMs).toBe(90_000);
  });

  it('cancel resets to idle without emitting complete', () => {
    const s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 30_000 },
      { type: 'CANCEL' },
    ]);
    expect(s.status).toBe('idle');
    expect(s.elapsedMs).toBe(0);
    expect(s.cuesStruck).toBe(0);
  });
});

describe('ritualReducer — guard rails', () => {
  const mt: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
  const cu: CountUpConfig = { mode: 'count_up' };

  it('TICK / PAUSE / COMPLETE on idle and RESUME on running are all no-ops', () => {
    const idle = initialState(mt);
    expect(ritualReducer(idle, { type: 'TICK', now: 1000 }, mt)).toBe(idle);
    expect(ritualReducer(idle, { type: 'PAUSE', now: 0 }, mt)).toBe(idle);
    expect(ritualReducer(idle, { type: 'COMPLETE', now: 0 }, mt)).toBe(idle);
    const running = drive(mt, [{ type: 'START', now: 0 }]);
    const stillRunning = ritualReducer(running, { type: 'RESUME', now: 1000 }, mt);
    expect(stillRunning.status).toBe('running');
  });

  it('TAP / ADVANCE_STEP are no-ops when not running or for non-tap modes', () => {
    const idleTarot = initialState({ mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 }, 3);
    expect(
      ritualReducer(
        idleTarot,
        { type: 'ADVANCE_STEP' },
        { mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 },
      ),
    ).toBe(idleTarot);
    const cuRunning = drive(cu, [
      { type: 'START', now: 0 },
      { type: 'TAP' },
      { type: 'ADVANCE_STEP' },
    ]);
    expect(cuRunning.repCount).toBe(0);
    expect(cuRunning.currentStepIndex).toBe(0);
  });

  it('COMPLETE while paused freezes the elapsed time captured before the pause', () => {
    const config: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
    let s = drive(config, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 30_000 },
      { type: 'PAUSE', now: 30_000 },
    ]);
    s = ritualReducer(s, { type: 'COMPLETE', now: 90_000 }, config);
    expect(s.status).toBe('complete');
    expect(s.elapsedMs).toBe(30_000);
  });

  it('CANCEL on idle returns the same state reference (no extra allocation)', () => {
    const idle = initialState({ mode: 'meditation_timer', duration_minutes: 5 });
    const after = ritualReducer(
      idle,
      { type: 'CANCEL' },
      {
        mode: 'meditation_timer',
        duration_minutes: 5,
      },
    );
    expect(after).toBe(idle);
  });

  it('TICK on a 0-minute meditation_timer guards against divide-by-zero', () => {
    const zero: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 0 };
    const s = drive(zero, [
      { type: 'START', now: 0 },
      { type: 'TICK', now: 1000 },
    ]);
    expect(s.progress).toBe(0);
    expect(s.status).toBe('complete');
  });
});
