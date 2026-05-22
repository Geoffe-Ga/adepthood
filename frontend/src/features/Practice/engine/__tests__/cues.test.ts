import { describe, expect, it } from '@jest/globals';

import { scheduledCues } from '../cues';
import type {
  CardMeditationConfig,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  TarotConfig,
} from '../types';

const MIN = 60_000;

describe('scheduledCues — meditation_timer', () => {
  it('emits start + halfway + end when all bells are on', () => {
    const config: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 10,
      start_bell: true,
      halfway_bell: true,
      end_bell: true,
    };
    expect(scheduledCues(config)).toEqual([
      { atMs: 0, kind: 'start_bell' },
      { atMs: 5 * MIN, kind: 'halfway_bell' },
      { atMs: 10 * MIN, kind: 'end_bell' },
    ]);
  });

  it('omits halfway when default and emits empty list when all bells off', () => {
    expect(scheduledCues({ mode: 'meditation_timer', duration_minutes: 10 })).toEqual([
      { atMs: 0, kind: 'start_bell' },
      { atMs: 10 * MIN, kind: 'end_bell' },
    ]);
    expect(
      scheduledCues({
        mode: 'meditation_timer',
        duration_minutes: 5,
        start_bell: false,
        halfway_bell: false,
        end_bell: false,
      }),
    ).toEqual([]);
  });
});

describe('scheduledCues — empty schedules', () => {
  it.each<ModeConfig>([
    { mode: 'count_up' },
    { mode: 'rep_counter', target_reps: 10, unit_label: 'breaths' },
    { mode: 'sense_grounding', prompts: [{ sense: 'sight', label: 'a tree' }] },
  ])('returns no cues for $mode', (config) => {
    expect(scheduledCues(config)).toEqual([]);
  });
});

describe('scheduledCues — metronome', () => {
  it('emits 600 ticks for bpm=60 over 10 minutes plus embedded timer cues', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: 60,
      timer: { mode: 'meditation_timer', duration_minutes: 10, halfway_bell: true },
    };
    const cues = scheduledCues(config);
    const ticks = cues.filter((c) => c.kind === 'metronome_tick');
    expect(ticks).toHaveLength(600);
    expect(ticks[0]?.atMs).toBe(1000);
    expect(ticks.at(-1)?.atMs).toBe(600_000);
    expect(cues.filter((c) => c.kind === 'halfway_bell')).toHaveLength(1);
  });

  it('respects the 10k tick safety cap', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: 240,
      timer: {
        mode: 'meditation_timer',
        duration_minutes: 1440,
        start_bell: false,
        end_bell: false,
      },
    };
    const ticks = scheduledCues(config).filter((c) => c.kind === 'metronome_tick');
    expect(ticks.length).toBeLessThanOrEqual(10_000);
  });
});

describe('scheduledCues — interval_bell', () => {
  it('expands interval_minutes=5 over duration=20 into 4 intervals + start + end', () => {
    const config: IntervalBellConfig = {
      mode: 'interval_bell',
      duration_minutes: 20,
      interval_minutes: 5,
      bell_tone: 'bowl',
    };
    const cues = scheduledCues(config);
    expect(cues.filter((c) => c.kind === 'interval_bell').map((c) => c.atMs)).toEqual([
      5 * MIN,
      10 * MIN,
      15 * MIN,
      20 * MIN,
    ]);
    expect(cues.filter((c) => c.kind === 'start_bell')).toHaveLength(1);
    expect(cues.filter((c) => c.kind === 'end_bell')).toHaveLength(1);
  });

  it('uses cue_offsets_minutes verbatim and degrades to start+end when neither set', () => {
    expect(
      scheduledCues({
        mode: 'interval_bell',
        duration_minutes: 15,
        cue_offsets_minutes: [3, 7, 12],
        bell_tone: 'chime',
      }),
    ).toHaveLength(5);
    expect(
      scheduledCues({ mode: 'interval_bell', duration_minutes: 10, bell_tone: 'gong' }),
    ).toEqual([
      { atMs: 0, kind: 'start_bell' },
      { atMs: 10 * MIN, kind: 'end_bell' },
    ]);
  });
});

describe('scheduledCues — tarot', () => {
  it.each<[string, TarotConfig]>([
    ['explicit per_card_minutes', { mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 }],
    ['default per_card_minutes', { mode: 'tarot', deck: 'major_arcana' }],
  ])('emits a single end cue (%s)', (_label, config) => {
    expect(scheduledCues(config)).toEqual([{ atMs: 5 * MIN, kind: 'end_bell' }]);
  });
});

describe('scheduledCues — card_meditation', () => {
  it.each<[string, CardMeditationConfig]>([
    [
      'explicit per_card_minutes',
      { mode: 'card_meditation', deck_id: 'rws', cards: null, per_card_minutes: 5 },
    ],
    ['default per_card_minutes', { mode: 'card_meditation', deck_id: 'rws', cards: null }],
  ])('emits a single end cue (%s)', (_label, config) => {
    expect(scheduledCues(config)).toEqual([{ atMs: 5 * MIN, kind: 'end_bell' }]);
  });
});

it('returns cues in non-decreasing atMs order', () => {
  const cues = scheduledCues({
    mode: 'metronome',
    bpm: 120,
    timer: { mode: 'meditation_timer', duration_minutes: 2, halfway_bell: true },
  });
  for (let i = 1; i < cues.length; i++) {
    expect(cues[i]?.atMs).toBeGreaterThanOrEqual(cues[i - 1]?.atMs ?? 0);
  }
});
