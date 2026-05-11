import React from 'react';
import { View } from 'react-native';

import type { CountUpConfig } from '../../engine/types';

import { LabeledRow, NumericField } from './shared';

interface Props {
  value: CountUpConfig;
  onChange: (next: CountUpConfig) => void;
}

const CountUpForm = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="count-up-form">
    <LabeledRow label="Soft cap (minutes, optional)">
      <NumericField
        value={value.soft_cap_minutes ?? null}
        onChange={(soft_cap_minutes) => onChange({ ...value, soft_cap_minutes })}
        placeholder="—"
        allowNull
        testID="count-up-soft-cap"
      />
    </LabeledRow>
  </View>
);

export default CountUpForm;
