import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { MindfulAnchorConfig, MindfulAnchorOption } from '../../engine/types';

import { LabeledRow, NumericField, TextField, ToggleRow } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface Props {
  value: MindfulAnchorConfig;
  onChange: (next: MindfulAnchorConfig) => void;
}

const INSTRUCTION_MAX = 280;
const LABEL_MAX = 60;
const DESCRIPTION_MAX = 120;

// Monotonic source of new option keys — the machine id recorded in session
// metadata, generated once and never derived from the array index (audit
// section 5.2 stable-key guidance).
let nextOptionKey = 0;

interface OptionRowProps {
  option: MindfulAnchorOption;
  index: number;
  onChange: (_patch: Partial<MindfulAnchorOption>) => void;
  onRemove: () => void;
}

const OptionRow = ({ option, index, onChange, onRemove }: OptionRowProps) => (
  <View style={localStyles.card} testID={`anchor-option-${index}`}>
    <TextField
      value={option.label}
      onChange={(label) => onChange({ label })}
      placeholder="Option label (e.g. Bare feet)"
      maxLength={LABEL_MAX}
      testID={`anchor-option-${index}-label`}
    />
    <TextField
      value={option.description ?? ''}
      onChange={(description) => onChange({ description })}
      placeholder="Hint (optional)"
      maxLength={DESCRIPTION_MAX}
      testID={`anchor-option-${index}-description`}
    />
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Remove option ${index + 1}`}
      onPress={onRemove}
      style={localStyles.removeButton}
      testID={`anchor-option-${index}-remove`}
    >
      <Text style={localStyles.removeButtonText}>Remove</Text>
    </TouchableOpacity>
  </View>
);

/** The scalar settings (instruction, minimum duration, require-choice toggle). */
const AnchorSettings = ({ value, onChange }: Props): React.JSX.Element => (
  <>
    <LabeledRow label="Instruction">
      <TextField
        value={value.instruction}
        onChange={(instruction) => onChange({ ...value, instruction })}
        placeholder="What to do (e.g. Stand on grass and breathe)"
        maxLength={INSTRUCTION_MAX}
        testID="anchor-instruction"
      />
    </LabeledRow>
    <LabeledRow label="Minimum duration (seconds)">
      <NumericField
        value={value.min_duration_seconds}
        onChange={(seconds) => onChange({ ...value, min_duration_seconds: seconds ?? 0 })}
        testID="anchor-min-duration"
      />
    </LabeledRow>
    <ToggleRow
      label="Require choosing an option"
      value={value.require_option_choice}
      onChange={(require_option_choice) => onChange({ ...value, require_option_choice })}
      testID="anchor-require-choice"
    />
  </>
);

const MindfulAnchorForm = ({ value, onChange }: Props): React.JSX.Element => {
  const setOption = (index: number, patch: Partial<MindfulAnchorOption>) => {
    const options = value.options.map((o, i) => (i === index ? { ...o, ...patch } : o));
    onChange({ ...value, options });
  };
  const removeOption = (index: number) =>
    onChange({ ...value, options: value.options.filter((_, i) => i !== index) });
  const addOption = () => {
    // Underscore, not hyphen: the key must match OPTION_KEY_PATTERN
    // (^[a-z][a-z0-9_]*$) or validateModeConfig rejects the new row.
    const key = `option_${(nextOptionKey += 1)}`;
    const next: MindfulAnchorOption = { key, label: '' };
    onChange({ ...value, options: [...value.options, next] });
  };
  return (
    <View testID="mindful-anchor-form">
      <AnchorSettings value={value} onChange={onChange} />
      {value.options.map((option, index) => (
        <OptionRow
          key={option.key}
          option={option}
          index={index}
          onChange={(patch) => setOption(index, patch)}
          onRemove={() => removeOption(index)}
        />
      ))}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Add option"
        onPress={addOption}
        style={localStyles.addButton}
        testID="anchor-add-option"
      >
        <Text style={localStyles.addButtonText}>+ Add option</Text>
      </TouchableOpacity>
    </View>
  );
};

const localStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  addButton: { paddingVertical: SPACING.sm },
  addButtonText: { color: colors.primary, fontWeight: '600' },
  removeButton: { paddingVertical: SPACING.xs },
  removeButtonText: { color: colors.danger },
});

export default MindfulAnchorForm;
