import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { IntervalBellConfig } from '../../engine/types';

import { BellToneRow, Chip, LabeledRow, NumericField } from './shared';

import { BORDER_RADIUS, SPACING, accent, editorialType, ink, surface } from '@/design/tokens';

interface Props {
  value: IntervalBellConfig;
  onChange: (next: IntervalBellConfig) => void;
}

type SpacingKind = 'even' | 'custom';

const detectKind = (value: IntervalBellConfig): SpacingKind =>
  value.cue_offsets_minutes !== undefined && value.cue_offsets_minutes !== null ? 'custom' : 'even';

const IntervalBellForm = ({ value, onChange }: Props): React.JSX.Element => {
  const kind = detectKind(value);
  return (
    <View testID="interval-bell-form">
      <DurationRow value={value} onChange={onChange} />
      <SpacingRow kind={kind} value={value} onChange={onChange} />
      {kind === 'even' ? (
        <EvenIntervalControls value={value} onChange={onChange} />
      ) : (
        <CustomOffsetControls value={value} onChange={onChange} />
      )}
      <BellToneRow value={value} onChange={onChange} testIDPrefix="interval-bell" />
    </View>
  );
};

const DurationRow = ({ value, onChange }: Props): React.JSX.Element => (
  <LabeledRow label="Duration (minutes)">
    <NumericField
      value={value.duration_minutes}
      onChange={(next) => onChange({ ...value, duration_minutes: next ?? 0 })}
      testID="interval-bell-duration"
    />
  </LabeledRow>
);

interface SpacingRowProps extends Props {
  kind: SpacingKind;
}

const SpacingRow = ({ kind, value, onChange }: SpacingRowProps): React.JSX.Element => {
  const switchKind = (next: SpacingKind) => {
    if (next === kind) return;
    if (next === 'even') {
      onChange({ ...value, interval_minutes: 5, cue_offsets_minutes: null });
    } else {
      onChange({ ...value, interval_minutes: null, cue_offsets_minutes: [] });
    }
  };
  return (
    <LabeledRow label="Spacing">
      <View style={localStyles.kindRow}>
        <Chip
          label="Even"
          active={kind === 'even'}
          onPress={() => switchKind('even')}
          testID="interval-bell-even"
        />
        <Chip
          label="Custom"
          active={kind === 'custom'}
          onPress={() => switchKind('custom')}
          testID="interval-bell-custom"
        />
      </View>
    </LabeledRow>
  );
};

const EvenIntervalControls = ({ value, onChange }: Props): React.JSX.Element => (
  <LabeledRow label="Interval (minutes)">
    <NumericField
      value={value.interval_minutes ?? null}
      onChange={(interval_minutes) => onChange({ ...value, interval_minutes })}
      placeholder="5"
      allowNull
      testID="interval-bell-interval"
    />
  </LabeledRow>
);

const CustomOffsetControls = ({ value, onChange }: Props): React.JSX.Element => {
  const offsets = value.cue_offsets_minutes ?? [];
  const removeAt = (index: number) => {
    const next = offsets.filter((_, i) => i !== index);
    onChange({ ...value, cue_offsets_minutes: next });
  };
  const append = (raw: number | null) => {
    if (raw === null || !Number.isFinite(raw)) return;
    onChange({ ...value, cue_offsets_minutes: [...offsets, raw] });
  };
  return (
    <View testID="interval-bell-offsets">
      <Text style={localStyles.subLabel}>Cue offsets (minutes from start)</Text>
      <View style={localStyles.chipWrap}>
        {offsets.map((offset, index) => (
          <TouchableOpacity
            key={`${offset}-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove offset ${offset}`}
            onPress={() => removeAt(index)}
            style={localStyles.offsetChip}
            testID={`interval-bell-offset-${index}`}
          >
            <Text style={localStyles.offsetChipText}>{offset} ✕</Text>
          </TouchableOpacity>
        ))}
      </View>
      <AddOffsetRow onAdd={append} />
    </View>
  );
};

const AddOffsetRow = ({ onAdd }: { onAdd: (raw: number | null) => void }): React.JSX.Element => {
  const [draft, setDraft] = React.useState<number | null>(null);
  return (
    <View style={localStyles.addRow}>
      <NumericField
        value={draft}
        onChange={setDraft}
        placeholder="e.g. 5"
        allowNull
        testID="interval-bell-offset-draft"
      />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Add offset"
        onPress={() => {
          onAdd(draft);
          setDraft(null);
        }}
        style={localStyles.addButton}
        testID="interval-bell-offset-add"
      >
        <Text style={localStyles.addButtonText}>Add</Text>
      </TouchableOpacity>
    </View>
  );
};

const localStyles = StyleSheet.create({
  kindRow: { flexDirection: 'row', gap: SPACING.xs, flexWrap: 'wrap' },
  subLabel: { ...editorialType.caption, color: ink.soft, marginTop: SPACING.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginVertical: SPACING.sm },
  offsetChip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.sunken,
  },
  offsetChipText: { ...editorialType.caption, color: ink.primary },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  addButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: accent.primary,
  },
  addButtonText: { color: accent.onPrimary, fontWeight: '600', fontSize: 13 },
});

export default IntervalBellForm;
