import type {
  CardMeditationConfig,
  Cue,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  TarotConfig,
} from './types';
import { DEFAULT_CARD_MEDITATION_MINUTES, DEFAULT_TAROT_MINUTES, MS_PER_MINUTE } from './types';
import { BPM_MAX, DURATION_MAX_MINUTES } from './validation';

// The validated worst case (max duration x max bpm): no in-range session ever
// hits it, so nothing valid is truncated. It only bounds memory for configs
// that reach here without passing validateMetronome.
const MAX_METRONOME_TICKS = DURATION_MAX_MINUTES * BPM_MAX;

/** Cue builder for modes whose pacing the engine does not drive (open-ended or view-owned). */
const noCues = (): readonly Cue[] => [];

/** Per-mode cue builders; the mapped type enforces exhaustive coverage. */
const CUE_BUILDERS: {
  [K in ModeConfig['mode']]: (config: Extract<ModeConfig, { mode: K }>) => readonly Cue[];
} = {
  meditation_timer: cuesForMeditation,
  count_up: noCues,
  metronome: cuesForMetronome,
  interval_bell: cuesForIntervalBell,
  random_interval_bell: noCues,
  rep_counter: noCues,
  sense_grounding: noCues,
  tallied_grounding: noCues,
  tarot: cuesForTarot,
  card_meditation: cuesForCardMeditation,
  mindful_anchor: noCues,
};

export function scheduledCues(config: ModeConfig): readonly Cue[] {
  type AnyBuilder = (config: ModeConfig) => readonly Cue[];
  return (CUE_BUILDERS[config.mode] as AnyBuilder)(config);
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
  const tickCount = Math.min(Math.floor(totalMs / intervalMs), MAX_METRONOME_TICKS);
  for (let i = 1; i <= tickCount; i++) {
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
    ...offsets.map((atMs): Cue => ({ atMs, kind: 'interval_bell', tone: config.bell_tone })),
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
  for (let t = intervalMs; t < totalMs; t += intervalMs) out.push(t);
  return out;
}

function cuesForTarot(config: TarotConfig): readonly Cue[] {
  const totalMs = (config.per_card_minutes ?? DEFAULT_TAROT_MINUTES) * MS_PER_MINUTE;
  return [{ atMs: totalMs, kind: 'end_bell' }];
}

function cuesForCardMeditation(config: CardMeditationConfig): readonly Cue[] {
  const totalMs = (config.per_card_minutes ?? DEFAULT_CARD_MEDITATION_MINUTES) * MS_PER_MINUTE;
  return [{ atMs: totalMs, kind: 'end_bell' }];
}

function sortCues(cues: Cue[]): readonly Cue[] {
  return [...cues].sort((a, b) => a.atMs - b.atMs);
}
