/**
 * Session view for the `random_interval_bell` mode.
 *
 * The bell schedule is non-deterministic, so — unlike `IntervalBellView`,
 * whose cues come from the engine — this view owns it: at session start
 * it pre-computes a list of offsets whose consecutive gaps are uniform in
 * `[min_interval_seconds, max_interval_seconds]` and whose cumulative sum
 * stays inside the duration. It then strikes the bell off the engine's
 * `elapsedMs` clock and lifts the resulting metadata up via
 * `onMetadataChange` so the parent can persist it on save.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { createExpoAudioAdapter } from '../engine/adapters/audio';
import type {
  AudioAdapter,
  RandomIntervalBellConfig,
  RandomIntervalBellMetadata,
  RitualControls,
  RitualState,
} from '../engine/types';
import { RANDOM_BELL_MAX_BELLS_CEILING } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';

import { SPACING, colors } from '@/design/tokens';

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

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

function generateSchedule(config: RandomIntervalBellConfig, random: () => number): Schedule {
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

/** Strike the bell for every newly-passed scheduled offset. */
function useIntervalBells(
  schedule: Schedule | null,
  struckCount: number,
  status: RitualState['status'],
  audio: AudioAdapter,
): void {
  const playedRef = useRef(0);
  useEffect(() => {
    if (status === 'idle') {
      playedRef.current = 0;
      return;
    }
    for (let i = playedRef.current; i < struckCount; i++) {
      audio.play('interval_bell');
    }
    playedRef.current = struckCount;
  }, [schedule, struckCount, status, audio]);
}

const RandomIntervalBellView = ({
  config,
  state,
  controls,
  random,
  audio,
  onMetadataChange,
}: Props): React.JSX.Element => {
  const rng = random ?? Math.random;
  const adapter = useBellAudio(audio);
  const schedule = useSessionSchedule(config, state.status, rng);

  const struckCount = useMemo(() => {
    if (schedule === null) return 0;
    return schedule.offsets.filter((offset) => offset * MS_PER_SECOND <= state.elapsedMs).length;
  }, [schedule, state.elapsedMs]);

  useBoundaryBells(config, state.status, adapter);
  useIntervalBells(schedule, struckCount, state.status, adapter);

  useEffect(() => {
    if (onMetadataChange === undefined) return;
    const intervals = schedule === null ? [] : schedule.deltas.slice(0, struckCount);
    onMetadataChange({
      mode: 'random_interval_bell',
      bells_struck: struckCount,
      interval_seconds: intervals,
    });
  }, [onMetadataChange, schedule, struckCount]);

  const total = schedule?.offsets.length ?? 0;
  const nextHint = nextBellHint(schedule, struckCount, state.elapsedMs, state.status);
  return (
    <View style={styles.container} testID="random-interval-bell-view">
      <Text style={styles.label}>elapsed</Text>
      <Text style={styles.time} testID="random-interval-bell-elapsed">
        {formatTime(state.elapsedMs)}
      </Text>
      <Text style={styles.count} testID="random-interval-bell-count">
        {`${struckCount} / ${total} bells`}
      </Text>
      {nextHint !== null && (
        <Text style={styles.hint} testID="random-interval-bell-next">
          {`Next bell in ~${nextHint}s`}
        </Text>
      )}
      <RitualControlsBar status={state.status} controls={controls} />
    </View>
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
  return Math.max(0, Math.round(nextOffset - elapsedMs / MS_PER_SECOND));
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: SPACING.xl, flex: 1 },
  label: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginTop: SPACING.xl,
  },
  time: {
    fontSize: 48,
    fontWeight: '300',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
    marginVertical: SPACING.md,
  },
  count: {
    fontSize: 18,
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACING.sm,
  },
  hint: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    marginBottom: SPACING.md,
  },
});

export default RandomIntervalBellView;
