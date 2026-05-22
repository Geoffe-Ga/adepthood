import type {
  Cue,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  TarotConfig,
} from './types';
import { DEFAULT_TAROT_MINUTES, MS_PER_MINUTE } from './types';

// Defensive: at bpm=240 over the max session this would otherwise blow up.
const MAX_METRONOME_TICKS = 10_000;

export function scheduledCues(config: ModeConfig): readonly Cue[] {
  switch (config.mode) {
    case 'meditation_timer':
      return cuesForMeditation(config);
    case 'count_up':
    case 'rep_counter':
    case 'sense_grounding':
    case 'tallied_grounding':
      return [];
    case 'metronome':
      return cuesForMetronome(config);
    case 'interval_bell':
      return cuesForIntervalBell(config);
    case 'tarot':
      return cuesForTarot(config);
  }
}

function cuesForMeditation(config: MeditationTimerConfig): readonly Cue[] {
  const totalMs = config.duration_minutes * MS_PER_MINUTE;
  const cues: Cue[] = [];
  if (config.start_bell ?? true) cues.push({ atMs: 0, kind: 'start_bell' });
  if (config.halfway_bell ?? false) cues.push({ atMs: totalMs / 2, kind: 'halfway_bell' });
  if (config.end_bell ?? true) cues.push({ atMs: totalMs, kind: 'end_bell' });
  return sortCues(cues);
}

function cuesForMetronome(config: MetronomeConfig): readonly Cue[] {
  const totalMs = config.timer.duration_minutes * MS_PER_MINUTE;
  const intervalMs = MS_PER_MINUTE / config.bpm;
  const ticks: Cue[] = [];
  for (let i = 1; i <= MAX_METRONOME_TICKS; i++) {
    const atMs = i * intervalMs;
    if (atMs > totalMs) break;
    ticks.push({ atMs, kind: 'metronome_tick' });
  }
  return sortCues([...cuesForMeditation(config.timer), ...ticks]);
}

function cuesForIntervalBell(config: IntervalBellConfig): readonly Cue[] {
  const totalMs = config.duration_minutes * MS_PER_MINUTE;
  const offsets = computeIntervalOffsets(config, totalMs);
  return sortCues([
    { atMs: 0, kind: 'start_bell' },
    ...offsets.map((atMs): Cue => ({ atMs, kind: 'interval_bell' })),
    { atMs: totalMs, kind: 'end_bell' },
  ]);
}

function computeIntervalOffsets(config: IntervalBellConfig, totalMs: number): readonly number[] {
  const offsets = config.cue_offsets_minutes;
  if (offsets && offsets.length > 0) return offsets.map((m) => m * MS_PER_MINUTE);
  const interval = config.interval_minutes;
  if (!interval || interval <= 0) return [];
  const intervalMs = interval * MS_PER_MINUTE;
  const out: number[] = [];
  for (let t = intervalMs; t <= totalMs; t += intervalMs) out.push(t);
  return out;
}

function cuesForTarot(config: TarotConfig): readonly Cue[] {
  const totalMs = (config.per_card_minutes ?? DEFAULT_TAROT_MINUTES) * MS_PER_MINUTE;
  return [{ atMs: totalMs, kind: 'end_bell' }];
}

function sortCues(cues: Cue[]): readonly Cue[] {
  return [...cues].sort((a, b) => a.atMs - b.atMs);
}
