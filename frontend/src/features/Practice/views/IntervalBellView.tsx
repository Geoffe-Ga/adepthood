import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { scheduledCues } from '../engine/cues';
import type { IntervalBellConfig, RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import type { SessionSurface } from './sessionSurface';
import { useSessionSurface } from './sessionSurface';
import { SessionContainer } from './shared';

import { SPACING } from '@/design/tokens';

interface Props {
  config: IntervalBellConfig;
  state: RitualState;
  controls: RitualControls;
}

const IntervalBellView = ({ config, state, controls }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  // Cue schedule is config-derived and pure; memoise so engine TICK re-renders
  // (which arrive 10× per second) don't rebuild the list each time.
  const cues = useMemo(() => scheduledCues(config), [config]);
  const untilNextMs =
    state.nextCueAtMs !== null ? Math.max(0, state.nextCueAtMs - state.elapsedMs) : 0;
  return (
    <SessionContainer testID="interval-bell-view" style={styles.container}>
      <Text style={[styles.label, { color: surface.textSoft }]}>next bell</Text>
      <Text style={[styles.time, { color: surface.text }]} testID="interval-bell-next">
        {formatTime(untilNextMs)}
      </Text>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        testID="interval-bell-offsets"
      >
        {cues.map((cue, idx) => (
          // Read-only derived schedule (no reorder/delete of editable rows), so
          // it rebuilds wholesale on config change — but key by the cue's
          // intrinsic identity (kind + offset) rather than the array index.
          <OffsetRow
            key={`${cue.kind}-${cue.atMs}`}
            atMs={cue.atMs}
            kind={cue.kind}
            struck={idx < state.cuesStruck}
            upcoming={idx === state.cuesStruck}
            surface={surface}
          />
        ))}
      </ScrollView>
      <RitualControlsBar status={state.status} controls={controls} />
    </SessionContainer>
  );
};

interface OffsetRowProps {
  atMs: number;
  kind: string;
  struck: boolean;
  upcoming: boolean;
  surface: SessionSurface;
}

const OffsetRow = ({
  atMs,
  kind,
  struck,
  upcoming,
  surface,
}: OffsetRowProps): React.JSX.Element => (
  <View
    style={[styles.row, upcoming && { backgroundColor: surface.raised }]}
    testID={`interval-bell-row-${atMs}`}
  >
    <Text
      style={[
        styles.rowTime,
        { color: surface.text },
        struck && [styles.rowStruck, { color: surface.textMuted }],
      ]}
    >
      {formatTime(atMs)}
    </Text>
    <Text
      style={[
        styles.rowKind,
        { color: surface.textSoft },
        struck && [styles.rowStruck, { color: surface.textMuted }],
      ]}
    >
      {kind}
    </Text>
    <Text
      style={[styles.rowMark, { color: surface.accent }]}
      testID={`interval-bell-row-mark-${atMs}`}
    >
      {struck ? '✓' : upcoming ? '→' : ''}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  label: {
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginTop: SPACING.xl,
  },
  time: {
    fontSize: 48,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    marginVertical: SPACING.md,
  },
  list: { width: '100%', maxHeight: 220, marginVertical: SPACING.md },
  listContent: { paddingVertical: SPACING.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 8,
  },
  rowTime: {
    flex: 0,
    width: 64,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  rowKind: { flex: 1, fontSize: 14 },
  rowMark: { width: 24, textAlign: 'right', fontSize: 16 },
  rowStruck: { textDecorationLine: 'line-through' },
});

export default IntervalBellView;
