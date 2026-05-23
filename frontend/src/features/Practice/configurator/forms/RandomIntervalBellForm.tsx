import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { IntervalBellTone, RandomIntervalBellConfig } from '../../engine/types';

import { Chip, LabeledRow, NumericField, ToggleRow } from './shared';

import { SPACING, colors } from '@/design/tokens';

const TONES: readonly IntervalBellTone[] = ['bowl', 'chime', 'gong'];

interface Props {
  value: RandomIntervalBellConfig;
  onChange: (next: RandomIntervalBellConfig) => void;
}

/**
 * Configurator form for the `random_interval_bell` mode. Core fields are
 * always visible; the rarer options live behind an "Advanced" toggle so
 * the form stays compact as the mode catalogue grows.
 */
const RandomIntervalBellForm = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="random-interval-bell-form">
    <LabeledRow label="Duration (minutes)">
      <NumericField
        value={value.duration_minutes}
        onChange={(next) => onChange({ ...value, duration_minutes: next ?? 0 })}
        testID="random-interval-bell-duration"
      />
    </LabeledRow>
    <LabeledRow label="Min interval (seconds)">
      <NumericField
        value={value.min_interval_seconds}
        onChange={(next) => onChange({ ...value, min_interval_seconds: next ?? 0 })}
        testID="random-interval-bell-min"
      />
    </LabeledRow>
    <LabeledRow label="Max interval (seconds)">
      <NumericField
        value={value.max_interval_seconds}
        onChange={(next) => onChange({ ...value, max_interval_seconds: next ?? 0 })}
        testID="random-interval-bell-max"
      />
    </LabeledRow>
    <BellToneRow value={value} onChange={onChange} />
    <AdvancedSection value={value} onChange={onChange} />
  </View>
);

const BellToneRow = ({ value, onChange }: Props): React.JSX.Element => (
  <LabeledRow label="Bell tone">
    <View style={styles.toneRow}>
      {TONES.map((tone) => (
        <Chip
          key={tone}
          label={tone}
          active={value.bell_tone === tone}
          onPress={() => onChange({ ...value, bell_tone: tone })}
          testID={`random-interval-bell-tone-${tone}`}
        />
      ))}
    </View>
  </LabeledRow>
);

const AdvancedSection = ({ value, onChange }: Props): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <View testID="random-interval-bell-advanced">
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Advanced settings"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((prev) => !prev)}
        style={styles.advancedToggle}
        testID="random-interval-bell-advanced-toggle"
      >
        <Text style={styles.advancedToggleText}>{`${open ? '▾' : '▸'} Advanced`}</Text>
      </TouchableOpacity>
      {open && <AdvancedFields value={value} onChange={onChange} />}
    </View>
  );
};

const AdvancedFields = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="random-interval-bell-advanced-fields">
    <LabeledRow label="Max bells (leave blank for no cap)">
      <NumericField
        value={value.max_bells ?? null}
        onChange={(next) => onChange({ ...value, max_bells: next })}
        placeholder="none"
        allowNull
        testID="random-interval-bell-max-bells"
      />
    </LabeledRow>
    <ToggleRow
      label="Start bell"
      value={value.start_bell ?? true}
      onChange={(start_bell) => onChange({ ...value, start_bell })}
      testID="random-interval-bell-start-bell"
    />
    <ToggleRow
      label="End bell"
      value={value.end_bell ?? true}
      onChange={(end_bell) => onChange({ ...value, end_bell })}
      testID="random-interval-bell-end-bell"
    />
  </View>
);

const styles = StyleSheet.create({
  toneRow: { flexDirection: 'row', gap: SPACING.xs, flexWrap: 'wrap' },
  advancedToggle: { paddingVertical: SPACING.md, marginTop: SPACING.sm },
  advancedToggleText: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
});

export default RandomIntervalBellForm;
