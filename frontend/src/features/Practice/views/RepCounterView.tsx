import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RepCounterConfig, RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import { useSessionSurface } from './sessionSurface';

import { SPACING } from '@/design/tokens';

interface Props {
  config: RepCounterConfig;
  state: RitualState;
  controls: RitualControls;
}

const RepCounterView = ({ config, state, controls }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  const canTap = state.status === 'running';
  const timeCapMs = config.time_cap_minutes != null ? config.time_cap_minutes * 60_000 : null;
  const remaining = timeCapMs !== null ? Math.max(0, timeCapMs - state.elapsedMs) : null;
  return (
    <View style={[styles.container, { backgroundColor: surface.ground }]} testID="rep-counter-view">
      <Pressable
        style={[styles.tapZone, { backgroundColor: surface.raised }]}
        onPress={canTap ? controls.tap : undefined}
        testID="rep-counter-tap-zone"
        accessibilityRole="button"
        accessibilityLabel={`Add one ${config.unit_label}`}
        accessibilityHint={canTap ? 'Double-tap to add a rep' : undefined}
      >
        <Text style={[styles.count, { color: surface.text }]} testID="rep-counter-count">
          {state.repCount}
        </Text>
        <Text style={[styles.target, { color: surface.textSoft }]}>of {config.target_reps}</Text>
        <Text style={[styles.unit, { color: surface.textSoft }]} testID="rep-counter-unit">
          {config.unit_label}
        </Text>
      </Pressable>
      {remaining !== null && (
        <Text style={[styles.timeCap, { color: surface.textMuted }]} testID="rep-counter-time-cap">
          time cap: {formatTime(remaining)}
        </Text>
      )}
      <RitualControlsBar status={state.status} controls={controls} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: SPACING.xl },
  tapZone: {
    width: '100%',
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
    marginBottom: SPACING.xl,
    borderRadius: 24,
  },
  count: {
    fontSize: 120,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  target: {
    fontSize: 18,
    marginTop: SPACING.xs,
  },
  unit: {
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginTop: SPACING.xs,
  },
  timeCap: {
    fontSize: 14,
    marginBottom: SPACING.xl,
    fontVariant: ['tabular-nums'],
  },
});

export default RepCounterView;
