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
import { MS_PER_MINUTE } from '../types';
import { BPM_MAX, DURATION_MAX_MINUTES } from '../validation';

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

  it('emits every tick for the worst-case valid session (max bpm, max duration)', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: BPM_MAX,
      timer: {
        mode: 'meditation_timer',
        duration_minutes: DURATION_MAX_MINUTES,
        start_bell: false,
        end_bell: false,
      },
    };
    const ticks = scheduledCues(config).filter((c) => c.kind === 'metronome_tick');
    expect(ticks.length).toBe(BPM_MAX * DURATION_MAX_MINUTES);
    expect(ticks.at(-1)?.atMs).toBe(DURATION_MAX_MINUTES * MS_PER_MINUTE);
  });

  it('emits all ticks for a mid-range session that exceeds the old 10k cap', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: 240,
      timer: {
        mode: 'meditation_timer',
        duration_minutes: 60,
        start_bell: false,
        halfway_bell: false,
        end_bell: false,
      },
    };
    const ticks = scheduledCues(config).filter((c) => c.kind === 'metronome_tick');
    expect(ticks.length).toBe(240 * 60);
    expect(ticks.at(-1)?.atMs).toBe(60 * MS_PER_MINUTE);
  });

  it('caps ticks at the worst-case ceiling for out-of-range input that bypasses validation', () => {
    const config: MetronomeConfig = {
      mode: 'metronome',
      bpm: BPM_MAX,
      timer: {
        mode: 'meditation_timer',
        duration_minutes: 2 * DURATION_MAX_MINUTES,
        start_bell: false,
        end_bell: false,
      },
    };
    const ticks = scheduledCues(config).filter((c) => c.kind === 'metronome_tick');
    expect(ticks.length).toBe(BPM_MAX * DURATION_MAX_MINUTES);
  });
});

describe('scheduledCues — interval_bell', () => {
  it('expands interval_minutes=5 over duration=20 into 3 interior intervals + start + end, dropping the endpoint collision and tagging the bell tone', () => {
    const config: IntervalBellConfig = {
      mode: 'interval_bell',
      duration_minutes: 20,
      interval_minutes: 5,
      bell_tone: 'bowl',
    };
    const cues = scheduledCues(config);
    const intervalCues = cues.filter((c) => c.kind === 'interval_bell');
    expect(intervalCues.map((c) => c.atMs)).toEqual([5 * MIN, 10 * MIN, 15 * MIN]);
    expect(cues.filter((c) => c.kind === 'start_bell')).toHaveLength(1);
    expect(cues.filter((c) => c.kind === 'end_bell')).toHaveLength(1);
    // Interval cues carry the configured bell tone; boundary cues carry none.
    expect(intervalCues.every((c) => c.tone === 'bowl')).toBe(true);
    const boundaryCues = cues.filter((c) => c.kind !== 'interval_bell');
    expect(boundaryCues.every((c) => c.tone === undefined)).toBe(true);
  });

  it('schedules exactly one cue at the endpoint and it is the end_bell when the interval divides the duration', () => {
    const cues = scheduledCues({
      mode: 'interval_bell',
      duration_minutes: 20,
      interval_minutes: 5,
      bell_tone: 'bowl',
    });
    const atEnd = cues.filter((c) => c.atMs === 20 * MIN);
    expect(atEnd.map((c) => c.kind)).toEqual(['end_bell']);
  });

  it('keeps the final interval cue when the interval does not divide the duration', () => {
    const cues = scheduledCues({
      mode: 'interval_bell',
      duration_minutes: 22,
      interval_minutes: 5,
      bell_tone: 'chime',
    });
    const intervalCues = cues.filter((c) => c.kind === 'interval_bell');
    expect(intervalCues.map((c) => c.atMs)).toEqual([5 * MIN, 10 * MIN, 15 * MIN, 20 * MIN]);
    const atEnd = cues.filter((c) => c.atMs === 22 * MIN);
    expect(atEnd.map((c) => c.kind)).toEqual(['end_bell']);
  });

  it('emits only start and end when the interval equals the duration', () => {
    const cues = scheduledCues({
      mode: 'interval_bell',
      duration_minutes: 10,
      interval_minutes: 10,
      bell_tone: 'gong',
    });
    expect(cues).toEqual([
      { atMs: 0, kind: 'start_bell' },
      { atMs: 10 * MIN, kind: 'end_bell' },
    ]);
  });

  it('uses cue_offsets_minutes verbatim, tagging the tone (chime), and degrades to untoned start+end when neither offset field is set (gong)', () => {
    const offsetCues = scheduledCues({
      mode: 'interval_bell',
      duration_minutes: 15,
      cue_offsets_minutes: [3, 7, 12],
      bell_tone: 'chime',
    });
    expect(offsetCues).toHaveLength(5);
    expect(
      offsetCues.filter((c) => c.kind === 'interval_bell').every((c) => c.tone === 'chime'),
    ).toBe(true);

    const gongCues = scheduledCues({
      mode: 'interval_bell',
      duration_minutes: 10,
      bell_tone: 'gong',
    });
    expect(gongCues).toEqual([
      { atMs: 0, kind: 'start_bell' },
      { atMs: 10 * MIN, kind: 'end_bell' },
    ]);
    expect(gongCues.every((c) => c.tone === undefined)).toBe(true);
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
