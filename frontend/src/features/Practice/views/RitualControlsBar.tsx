import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { EngineStatus, RitualControls } from '../engine/types';

import { useSessionSurface } from './sessionSurface';

import { Celebration } from '@/components/feedback/Celebration';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

type Variant = 'primary' | 'secondary' | 'danger';

interface Props {
  status: EngineStatus;
  controls: Pick<RitualControls, 'start' | 'pause' | 'resume' | 'cancel'>;
  /** Optional override for the START button label (e.g., "Begin"). */
  startLabel?: string;
}

const RunningControls = ({ controls }: Pick<Props, 'controls'>): React.JSX.Element => (
  <>
    <Button variant="secondary" label="Pause" onPress={controls.pause} testID="ritual-pause" />
    <Button variant="danger" label="Cancel" onPress={controls.cancel} testID="ritual-cancel" />
  </>
);

const PausedControls = ({ controls }: Pick<Props, 'controls'>): React.JSX.Element => (
  <>
    <Button variant="primary" label="Resume" onPress={controls.resume} testID="ritual-resume" />
    <Button variant="danger" label="Cancel" onPress={controls.cancel} testID="ritual-cancel" />
  </>
);

/** The completion line, played through the shared reduced-motion-safe Celebration. */
const CompleteLabel = ({ color }: { color: string }): React.JSX.Element => (
  <Celebration active testID="ritual-complete-celebration">
    <Text style={[styles.completeText, { color }]} testID="ritual-complete-label">
      Practice complete
    </Text>
  </Celebration>
);

const RitualControlsBar = ({
  status,
  controls,
  startLabel = 'Start',
}: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  return (
    <View style={styles.row} testID="ritual-controls-bar">
      {status === 'idle' && (
        <Button
          variant="primary"
          label={startLabel}
          onPress={controls.start}
          testID="ritual-start"
        />
      )}
      {status === 'running' && <RunningControls controls={controls} />}
      {status === 'paused' && <PausedControls controls={controls} />}
      {status === 'complete' && <CompleteLabel color={surface.accent} />}
    </View>
  );
};

interface ButtonProps {
  variant: Variant;
  label: string;
  onPress: () => void;
  testID: string;
}

const Button = ({ variant, label, onPress, testID }: ButtonProps): React.JSX.Element => (
  <TouchableOpacity
    style={[styles.button, styles[variant]]}
    onPress={onPress}
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
  >
    <Text style={variant === 'danger' ? styles.dangerText : styles.lightText}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center', justifyContent: 'center' },
  button: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    minWidth: 120,
    alignItems: 'center',
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.warning },
  danger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  lightText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  dangerText: { color: colors.danger, fontSize: 16, fontWeight: '600' },
  completeText: {
    color: colors.success,
    fontSize: 16,
    fontWeight: '600',
    paddingVertical: SPACING.md,
  },
});

export default RitualControlsBar;
