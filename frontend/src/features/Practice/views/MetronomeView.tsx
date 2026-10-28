import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import type { MetronomeConfig, RitualControls, RitualState } from '../engine/types';

import { formatTime, spokenTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import { useSessionSurface } from './sessionSurface';
import { SESSION_CAPTION_LABEL, SESSION_DISPLAY_MAX_FONT_SCALE, SessionContainer } from './shared';

import { SPACING } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const PULSE_DURATION_MS = 120;
const PULSE_MAX_SCALE = 1.6;

interface Props {
  config: MetronomeConfig;
  state: RitualState;
  controls: RitualControls;
}

/**
 * A scale value that pulses once per struck cue. Under the OS "Reduce Motion"
 * setting the dot stays still; the beat is still felt through the haptic tick.
 */
function useBeatPulse(cuesStruck: number): Animated.Value {
  const pulse = useRef(new Animated.Value(1)).current;
  const lastStruckRef = useRef(cuesStruck);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (cuesStruck === lastStruckRef.current) return;
    lastStruckRef.current = cuesStruck;
    if (reduced) return;
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
  }, [cuesStruck, pulse, reduced]);

  return pulse;
}

const MetronomeView = ({ config, state, controls }: Props): React.JSX.Element => {
  const pulse = useBeatPulse(state.cuesStruck);
  const surface = useSessionSurface();
  const elapsedMs = state.elapsedMs;
  return (
    <SessionContainer testID="metronome-view">
      <Text
        style={[styles.bpm, { color: surface.text }]}
        testID="metronome-bpm"
        maxFontSizeMultiplier={SESSION_DISPLAY_MAX_FONT_SCALE}
      >
        {config.bpm}
      </Text>
      <Text style={[styles.label, { color: surface.textSoft }]}>bpm</Text>
      <Animated.View
        style={[styles.dot, { backgroundColor: surface.accent, transform: [{ scale: pulse }] }]}
        testID="metronome-pulse"
      />
      <Text
        style={[styles.miniTimer, { color: surface.textSoft }]}
        testID="metronome-mini-timer"
        accessibilityRole="timer"
        accessibilityLabel={spokenTime(elapsedMs, 'elapsed')}
        accessibilityLiveRegion="polite"
      >
        {formatTime(elapsedMs)}
      </Text>
      <View style={styles.spacer} />
      <RitualControlsBar status={state.status} controls={controls} />
    </SessionContainer>
  );
};

const styles = StyleSheet.create({
  bpm: {
    fontSize: 84,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    marginTop: SPACING.xl,
  },
  label: {
    ...SESSION_CAPTION_LABEL,
    marginBottom: SPACING.xl,
  },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginBottom: SPACING.xl,
  },
  miniTimer: {
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACING.xl,
  },
  spacer: { height: SPACING.md },
});

export default MetronomeView;
