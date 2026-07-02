import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import type { RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import { useSessionSurface } from './sessionSurface';
import { SessionContainer } from './shared';

import { SPACING, shadows } from '@/design/tokens';

const RING_SIZE = 240;
const STROKE_WIDTH = 8;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CENTER = RING_SIZE / 2;

interface Props {
  state: RitualState;
  controls: RitualControls;
}

const MeditationTimerView = ({ state, controls }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  const dashOffset = CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, state.progress)));
  const remainingMs = state.remainingMs ?? 0;
  return (
    <SessionContainer testID="meditation-timer-view">
      <View style={styles.ringContainer}>
        <Svg width={RING_SIZE} height={RING_SIZE} testID="meditation-timer-ring">
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            stroke={surface.ground}
            strokeWidth={STROKE_WIDTH}
            fill={surface.raised}
          />
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            stroke={surface.accent}
            strokeWidth={STROKE_WIDTH}
            fill="none"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text style={[styles.time, { color: surface.text }]} testID="meditation-time-remaining">
            {formatTime(remainingMs)}
          </Text>
        </View>
      </View>
      <RitualControlsBar status={state.status} controls={controls} />
    </SessionContainer>
  );
};

const styles = StyleSheet.create({
  ringContainer: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xxl,
    ...shadows.medium,
  },
  center: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  time: {
    fontSize: 42,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
  },
});

export default MeditationTimerView;
