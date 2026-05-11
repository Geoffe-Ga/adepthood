import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import type { MetronomeConfig, RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';

import { SPACING, colors } from '@/design/tokens';

const PULSE_DURATION_MS = 120;
const PULSE_MAX_SCALE = 1.6;

interface Props {
  config: MetronomeConfig;
  state: RitualState;
  controls: RitualControls;
}

const MetronomeView = ({ config, state, controls }: Props): React.JSX.Element => {
  const pulse = useRef(new Animated.Value(1)).current;
  const lastStruckRef = useRef(state.cuesStruck);

  useEffect(() => {
    if (state.cuesStruck === lastStruckRef.current) return;
    lastStruckRef.current = state.cuesStruck;
    Animated.sequence([
      Animated.timing(pulse, {
        toValue: PULSE_MAX_SCALE,
        duration: PULSE_DURATION_MS / 2,
        useNativeDriver: true,
      }),
      Animated.timing(pulse, {
        toValue: 1,
        duration: PULSE_DURATION_MS / 2,
        useNativeDriver: true,
      }),
    ]).start();
  }, [state.cuesStruck, pulse]);

  const elapsedMs = state.elapsedMs;
  return (
    <View style={styles.container} testID="metronome-view">
      <Text style={styles.bpm} testID="metronome-bpm">
        {config.bpm}
      </Text>
      <Text style={styles.label}>bpm</Text>
      <Animated.View
        style={[styles.dot, { transform: [{ scale: pulse }] }]}
        testID="metronome-pulse"
      />
      <Text style={styles.miniTimer} testID="metronome-mini-timer">
        {formatTime(elapsedMs)}
      </Text>
      <View style={styles.spacer} />
      <RitualControlsBar status={state.status} controls={controls} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: SPACING.xl },
  bpm: {
    fontSize: 84,
    fontWeight: '200',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
    marginTop: SPACING.xl,
  },
  label: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: SPACING.xl,
  },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.success,
    marginBottom: SPACING.xl,
  },
  miniTimer: {
    fontSize: 24,
    color: colors.text.secondary,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACING.xl,
  },
  spacer: { height: SPACING.md },
});

export default MetronomeView;
