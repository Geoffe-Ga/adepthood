import React from 'react';
import { View } from 'react-native';

import type { MindfulAnchorConfig, MindfulAnchorOption } from '../../engine/types';
import {
  INSTRUCTION_MAX,
  OPTION_DESCRIPTION_MAX as DESCRIPTION_MAX,
  OPTION_LABEL_MAX as LABEL_MAX,
} from '../../engine/validation';

import { makeRowKeyFactory } from './rowKeys';
import {
  AddRowButton,
  LabeledRow,
  NumericField,
  RemoveButton,
  RowCard,
  TextField,
  ToggleRow,
} from './shared';

interface Props {
  value: MindfulAnchorConfig;
  onChange: (next: MindfulAnchorConfig) => void;
}

// New option keys are the machine id recorded in session metadata, minted once
// and never derived from the array index. Underscore, not hyphen: the key must
// match OPTION_KEY_PATTERN (^[a-z][a-z0-9_]*$) or validateModeConfig rejects it.
const nextOptionKey = makeRowKeyFactory('option');

interface OptionRowProps {
  option: MindfulAnchorOption;
  index: number;
  onChange: (_patch: Partial<MindfulAnchorOption>) => void;
  onRemove: () => void;
}

const OptionRow = ({ option, index, onChange, onRemove }: OptionRowProps) => (
  <RowCard testID={`anchor-option-${index}`}>
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
    <RemoveButton
      noun="option"
      index={index}
      onPress={onRemove}
      testID={`anchor-option-${index}-remove`}
    />
  </RowCard>
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
    const next: MindfulAnchorOption = { key: nextOptionKey(), label: '' };
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
      <AddRowButton noun="option" onPress={addOption} testID="anchor-add-option" />
    </View>
  );
};

export default MindfulAnchorForm;
