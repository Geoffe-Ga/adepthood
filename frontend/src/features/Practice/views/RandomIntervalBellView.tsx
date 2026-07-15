/** Session view for `random_interval_bell`: schedules its own bells (engine cues are empty). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { createExpoAudioAdapter } from '../engine/adapters/audio';
import type {
  AudioAdapter,
  IntervalBellTone,
  RandomIntervalBellConfig,
  RandomIntervalBellMetadata,
  RitualControls,
  RitualState,
} from '../engine/types';
import { MS_PER_SECOND, RANDOM_BELL_MAX_BELLS_CEILING, SECONDS_PER_MINUTE } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import { useSessionSurface } from './sessionSurface';
import { SESSION_BIG_TIME, SESSION_CAPTION_LABEL, SessionContainer } from './shared';

import { SPACING } from '@/design/tokens';

interface Props {
  config: RandomIntervalBellConfig;
  state: RitualState;
  controls: RitualControls;
  /** Injectable RNG for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable audio adapter for tests; defaults to the bundled bell audio. */
  audio?: AudioAdapter;
  /** Lifts session metadata up so the parent can harvest it on save. */
  onMetadataChange?: (metadata: RandomIntervalBellMetadata) => void;
}

/** A pre-computed random bell schedule for one session. */
interface Schedule {
  /** Bell offsets in seconds from start, strictly increasing. */
  offsets: readonly number[];
  /** Whole-second gap before each bell; one entry per offset. */
  deltas: readonly number[];
}

/** Build the random bell schedule for a session; exported for direct unit tests. */
export function generateSchedule(config: RandomIntervalBellConfig, random: () => number): Schedule {
  const totalSeconds = config.duration_minutes * SECONDS_PER_MINUTE;
  const span = config.max_interval_seconds - config.min_interval_seconds;
  const cap = Math.min(
    config.max_bells ?? RANDOM_BELL_MAX_BELLS_CEILING,
    RANDOM_BELL_MAX_BELLS_CEILING,
  );
  const offsets: number[] = [];
  const deltas: number[] = [];
  let elapsed = 0;
  while (offsets.length < cap) {
    const gap = config.min_interval_seconds + random() * span;
    elapsed += gap;
    if (elapsed >= totalSeconds) break;
    offsets.push(elapsed);
    deltas.push(Math.max(1, Math.round(gap)));
  }
  return { offsets, deltas };
}

/** Resolve the audio adapter once; an injected one is honoured for tests. */
function useBellAudio(injected?: AudioAdapter): AudioAdapter {
  const [adapter] = useState<AudioAdapter>(() => injected ?? createExpoAudioAdapter());
  useEffect(() => () => adapter.dispose?.(), [adapter]);
  return adapter;
}

/** Generate the schedule on `idle → running`; clear it back on `→ idle`. */
function useSessionSchedule(
  config: RandomIntervalBellConfig,
  status: RitualState['status'],
  random: () => number,
): Schedule | null {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  useEffect(() => {
    // `schedule === null` guard makes a mid-session config change a no-op (engine contract).
    if (status === 'running' && schedule === null) {
      setSchedule(generateSchedule(config, random));
    } else if (status === 'idle' && schedule !== null) {
      setSchedule(null);
    }
  }, [status, schedule, config, random]);
  return schedule;
}

/** Play the start bell once per session and the end bell once on completion. */
function useBoundaryBells(
  config: RandomIntervalBellConfig,
  status: RitualState['status'],
  audio: AudioAdapter,
): void {
  const prevStatusRef = useRef<RitualState['status']>(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev !== 'running' && status === 'running' && (config.start_bell ?? true)) {
      audio.play('start_bell');
    }
    if (prev !== 'complete' && status === 'complete' && (config.end_bell ?? true)) {
      audio.play('end_bell');
    }
  }, [status, config.start_bell, config.end_bell, audio]);
}

/** Strike the configured-tone bell for every newly-passed scheduled offset. */
function useIntervalBells(
  schedule: Schedule | null,
  struckCount: number,
  status: RitualState['status'],
  audio: AudioAdapter,
  tone: IntervalBellTone,
): void {
  const playedRef = useRef(0);
  useEffect(() => {
    if (status === 'idle') {
      playedRef.current = 0;
      return;
    }
    for (let i = playedRef.current; i < struckCount; i++) {
      audio.play('interval_bell', tone);
    }
    playedRef.current = struckCount;
  }, [schedule, struckCount, status, audio, tone]);
}

const RandomIntervalBellView = ({
  config,
  state,
  controls,
  random,
  audio,
  onMetadataChange,
}: Props): React.JSX.Element => {
  // Stabilise so a fresh `random` prop identity can't retrigger the schedule effect.
  const rng = useMemo(() => random ?? Math.random, [random]);
  const adapter = useBellAudio(audio);
  const schedule = useSessionSchedule(config, state.status, rng);

  const struckCount = useMemo(() => {
    if (schedule === null) return 0;
    return schedule.offsets.filter((offset) => offset * MS_PER_SECOND <= state.elapsedMs).length;
  }, [schedule, state.elapsedMs]);

  useBoundaryBells(config, state.status, adapter);
  useIntervalBells(schedule, struckCount, state.status, adapter, config.bell_tone);

  useEffect(() => {
    if (onMetadataChange === undefined) return;
    const intervals = schedule === null ? [] : schedule.deltas.slice(0, struckCount);
    onMetadataChange({
      mode: 'random_interval_bell',
      bells_struck: struckCount,
      interval_seconds: intervals,
    });
  }, [onMetadataChange, schedule, struckCount]);

  const surface = useSessionSurface();
  const total = schedule?.offsets.length ?? 0;
  const nextHint = nextBellHint(schedule, struckCount, state.elapsedMs, state.status);
  return (
    <SessionContainer testID="random-interval-bell-view" style={styles.fill}>
      <Text style={[styles.label, { color: surface.textSoft }]}>elapsed</Text>
      <Text style={[styles.time, { color: surface.text }]} testID="random-interval-bell-elapsed">
        {formatTime(state.elapsedMs)}
      </Text>
      <Text style={[styles.count, { color: surface.text }]} testID="random-interval-bell-count">
        {`${struckCount} / ${total} bells`}
      </Text>
      {nextHint !== null && (
        <Text style={[styles.hint, { color: surface.textSoft }]} testID="random-interval-bell-next">
          {`Next bell in ~${nextHint}s`}
        </Text>
      )}
      <RitualControlsBar status={state.status} controls={controls} />
    </SessionContainer>
  );
};

/** Seconds until the next unstruck bell, or `null` when there is none to show. */
function nextBellHint(
  schedule: Schedule | null,
  struckCount: number,
  elapsedMs: number,
  status: RitualState['status'],
): number | null {
  if (status !== 'running' || schedule === null) return null;
  const nextOffset = schedule.offsets[struckCount];
  if (nextOffset === undefined) return null;
  // Floor at 1s so the hint never flashes "~0s" the instant before a strike.
  return Math.max(1, Math.round(nextOffset - elapsedMs / MS_PER_SECOND));
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  label: {
    ...SESSION_CAPTION_LABEL,
    marginTop: SPACING.xl,
  },
  time: {
    ...SESSION_BIG_TIME,
    marginVertical: SPACING.md,
  },
  count: {
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACING.sm,
  },
  hint: {
    fontSize: 14,
    marginBottom: SPACING.md,
  },
});

export default RandomIntervalBellView;
