import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import { useSessionSurface } from './sessionSurface';
import { SUCCESS_FILL, SessionContainer } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface Props {
  state: RitualState;
  controls: RitualControls;
}

const CountUpTimerView = ({ state, controls }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  return (
    <SessionContainer testID="count-up-timer-view">
      <Text style={[styles.time, { color: surface.text }]} testID="count-up-elapsed">
        {formatTime(state.elapsedMs)}
      </Text>
      <Text style={[styles.label, { color: surface.textSoft }]}>elapsed</Text>
      {state.status === 'running' && (
        <TouchableOpacity
          style={[styles.endButton, SUCCESS_FILL]}
          onPress={controls.complete}
          testID="count-up-end"
          accessibilityRole="button"
          accessibilityLabel="End session"
        >
          <Text style={styles.endButtonText}>End session</Text>
        </TouchableOpacity>
      )}
      <View style={styles.spacer} />
      <RitualControlsBar status={state.status} controls={controls} />
    </SessionContainer>
  );
};

const styles = StyleSheet.create({
  time: {
    fontSize: 64,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    marginTop: SPACING.xxl,
  },
  label: {
    fontSize: 14,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xl,
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  endButton: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.xl,
  },
  endButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  spacer: { height: SPACING.md },
});

export default CountUpTimerView;
