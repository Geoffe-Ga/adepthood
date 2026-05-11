import React from 'react';
import { View } from 'react-native';

import type { RepCounterConfig } from '../../engine/types';
import { UNIT_LABEL_MAX } from '../../engine/validation';

import { LabeledRow, NumericField, TextField } from './shared';

interface Props {
  value: RepCounterConfig;
  onChange: (next: RepCounterConfig) => void;
}

const RepCounterForm = ({ value, onChange }: Props): React.JSX.Element => {
  const update = (patch: Partial<RepCounterConfig>) => onChange({ ...value, ...patch });
  return (
    <View testID="rep-counter-form">
      <LabeledRow label="Target reps">
        <NumericField
          value={value.target_reps}
          onChange={(next) => update({ target_reps: Math.round(next ?? 0) })}
          testID="rep-counter-target"
        />
      </LabeledRow>
      <LabeledRow label="Unit label">
        <TextField
          value={value.unit_label}
          onChange={(unit_label) => update({ unit_label })}
          placeholder="reps"
          maxLength={UNIT_LABEL_MAX}
          testID="rep-counter-unit"
        />
      </LabeledRow>
      <LabeledRow label="Time cap (minutes, optional)">
        <NumericField
          value={value.time_cap_minutes ?? null}
          onChange={(time_cap_minutes) => update({ time_cap_minutes })}
          placeholder="—"
          allowNull
          testID="rep-counter-time-cap"
        />
      </LabeledRow>
    </View>
  );
};

export default RepCounterForm;
